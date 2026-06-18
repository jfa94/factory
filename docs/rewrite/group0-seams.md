# Group 0 — Frozen Seam Contract

> **Status: FROZEN (adversarially verified).** Group-1 workstreams (WS3 git, WS4
> quota, WS5 spec, WS7 judgment, WS9 hooks) and Group-2+ (WS6, WS8, WS10, WS12)
> build against these types and MUST NOT redefine them. A change here is a
> design change — open a decision, do not edit in place during a downstream WS.

This is the contract Group 0 (WS0 substrate · WS1 state core · WS2 stage machine)
exports. It is the synthesis of the plan's Group-0 acceptance criteria
(`/Users/Javier/.claude/plans/magical-hatching-deer.md`) after the freeze. Every
downstream import resolves through the single barrel **`src/types`** — deep imports
into `src/core/*` are a smell, the barrel is the addressable surface.

## What "frozen" means here

Two adversarial verify passes (one per workstream) plus a combined re-verify
confirmed:

- the closed enums, `StateManager`, derive-don't-store accessors, and `(repo,
spec-id)` keying (WS1);
- the `StageResult` union, `SpawnManifest`, stage vocabulary, handler interface,
  and pure engine (WS2);
- and that `src/types` is a **complete, non-dangling mirror** of both owning
  modules (37 stage-machine exports + the WS1 surface).

All blockers found during verification are closed; `pnpm run typecheck`, the full
vitest suite (158 tests), and `pnpm run build` (2 bundles) are green.

---

## 1. The single import surface — `src/types`

```ts
import {
  // WS1 state core
  RunStateSchema,
  TaskStateSchema,
  SpecPointerSchema,
  parseRunState,
  parseTaskState, // ← USE THESE, not raw .parse
  StateManager,
  deriveGateVerdict,
  deriveAllGatesVerdict,
  derivePanelVerdict,
  deriveFloorVerdict,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  RunStatusEnum,
  TaskStatusEnum,
  FailureClassEnum,
  RiskTierEnum,
  PanelVerdictEnum,
  // WS2 stage machine
  runStage,
  nextStageFor,
  decideFinalize,
  StageEngine,
  advance,
  spawn,
  gracefulStop,
  waitRetry,
  taskDone,
  taskDropped,
  finalizeTerminal,
  assertNever,
  isTerminalResult,
  parseSpawnManifest,
  TaskStageEnum,
  RunStageEnum,
  nextStage,
  stageToInFlightStatus,
} from "../types/index.js";

import type {
  RunState,
  TaskState,
  SpecPointer,
  RunStatus,
  TaskStatus,
  FailureClass,
  RiskTier,
  PanelVerdict,
  ReviewerResult,
  QuotaCheckpoint,
  GateEvidence,
  GateVerdict,
  StageResult,
  SpawnManifest,
  SpawnAgent,
  SpawnRole,
  TaskStage,
  RunStage,
  EngineStage,
  StageContext,
  StageHandlers,
  AdvanceResult,
  SpawnAgentsResult,
  GracefulStopResult,
  WaitRetryResult,
  TaskTerminalResult,
  FinalizeTerminalResult,
} from "../types/index.js";
```

---

## 2. WS1 — State core

### 2.1 Closed enums (the seam's vocabulary)

A value outside any set is a **loud parse error**, never a silent pass.

| Enum           | Members                                                                    | Notes                                                                                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RunStatus`    | `running` · `completed` · `superseded` · `paused` · `suspended` · `failed` | terminal = {completed, failed, superseded}; `superseded` marks a run replaced by `--supersede` (Decision 35), `paused`/`suspended` are **quota** states (Δ E — kept distinct). `partial` was retired (Decision 34 — develop receives whole PRDs only). |
| `TaskStatus`   | `pending` · `executing` · `reviewing` · `shipping` · `done` · `dropped`    | terminal = {done, dropped}. No human-gate statuses (Decision 5).                                                                                                                                                                                       |
| `FailureClass` | `capability-budget` · `spec-defect` · `blocked-environmental`              | closed (Δ D); set **IFF** task is `dropped`.                                                                                                                                                                                                           |
| `RiskTier`     | `low` · `medium` · `high`                                                  | the **single** producer dial (Decision 25); does not size the verifier.                                                                                                                                                                                |
| `PanelVerdict` | `approve` · `blocked` · `error`                                            | floor is conjunctive (unanimous `approve`); `error` is never silently an approve.                                                                                                                                                                      |

### 2.2 Cross-field invariants (enforced at parse time)

Enforced by `superRefine` on internal `*Checked` schemas, applied by the parse
functions. The exported `TaskStateSchema`/`RunStateSchema` stay plain `z.object`
so downstream keeps `.shape`/`.extend`.

- **`failure_class` set IFF `status === "dropped"`** — a drop must be classified;
  a class on any non-dropped status is rejected.
- **`quota` checkpoint present only while `paused`|`suspended`** — resume must
  clear it before returning to `running`; a terminal run never carries one.

> ⚠️ **Always validate untrusted/on-disk state with `parseRunState` /
> `parseTaskState`.** A raw `RunStateSchema.parse` runs the per-task check (tasks
> use `TaskStateChecked`) but **skips the run-level quota invariant**. Use the bare
> schema only to derive a shape (`.shape`/`.extend`). The `StateManager` already
> routes every read/write through the checked parsers.

### 2.3 `SpecPointer` — `(repo, spec-id)` keying (Δ X)

A run **points at** a durable spec; it never embeds one.

```ts
SpecPointer = { repo: string; spec_id: string; issue_number: number }
// spec_id = "<issue>-<slug>"; issue_number is the stable lookup key, slug is human-readable.
```

### 2.4 `StateManager` — the only sanctioned state I/O

```ts
new StateManager({ dataDir?, lock? })
  .create(args: CreateRunArgs): Promise<RunState>   // refuses to clobber; race-safe (TOCTOU re-check INSIDE the lock)
  .read(runId): Promise<RunState>
  .readCurrent(): Promise<RunState | null>          // resolves runs/current symlink
  .update(runId, mutator): Promise<RunState>         // read-modify-write under lock; re-stamps updated_at; re-validates
  .updateTask(runId, taskId, mutator): Promise<RunState>  // throws on unknown task id (no silent create)
  .finalize(runId, terminalStatus): Promise<RunState>     // terminal-only; idempotent for same status; refuses re-finalize to a different status
```

Mechanics (frozen): atomic write = temp + fsync + rename + fsync-parent; a robust
`proper-lockfile` held for the whole read-modify-write cycle (replaces the bash
flock-10s-with-mkdir-fallback); reads are lock-free; a compromised lock **throws**.

### 2.5 derive-don't-store — gate verdicts (Δ V)

There is **no stored gate boolean** anywhere in `TaskState`. A verdict can only be
produced by a `derive*` accessor, from ground truth handed in as an argument:

```ts
deriveGateVerdict(evidence: GateEvidence): GateVerdict           // single gate; passes iff evidence.observed (false/absent ⇒ FAILS, never defaults open)
deriveAllGatesVerdict(evidence: GateEvidence[]): GateVerdict     // conjunctive; empty set ⇒ FAILS
derivePanelVerdict(reviewers | task): GateVerdict                // unanimous approve; ≥1 reviewer required
deriveFloorVerdict(task, gateEvidence): GateVerdict              // BOTH layers must pass (Decision 26)
```

`GateVerdict` carries `__derived: true` + a `from` audit trail. A forged on-disk
`*_gate` field is stripped on read by Zod **and** ignored by derivation.

---

## 3. WS2 — Stage machine

### 3.1 Stage vocabulary (two separate closed enums)

```ts
TaskStage = "preflight" | "tests" | "exec" | "verify" | "ship"; // per-task order
RunStage = "finalize"; // run-level, runs ONCE, terminal
EngineStage = TaskStage | RunStage;
```

`finalize` is deliberately a **separate** enum so `nextStage` walking past `ship`
can never reach it. Helpers: `nextStage(s)` (→ next or `null`), `stageToInFlightStatus(s)`
(maps a running stage to the WS1 in-flight `TaskStatus` the driver should persist —
the engine never writes state).

### 3.2 `StageResult` — the engine↔driver seam (discriminated union on `kind`)

| `kind`              | Payload                                                 | Meaning                                                                        |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `advance`           | `to: TaskStage`                                         | stage done, no spawn; resume at `to`.                                          |
| `spawn-agents`      | `manifest: SpawnManifest`                               | spawn agents, resume at `manifest.stage_after`.                                |
| `graceful-stop`     | `scope: "5h"\|"7d"`, `reason`, `resets_at_epoch?`       | quota breach — pause (5h) / suspend (7d). Never a drop.                        |
| `wait-retry`        | `stage`, `reason`, `attempt`, `max_attempts`            | re-invoke SAME stage; **bounded** (engine throws if `attempt > max_attempts`). |
| `task-terminal`     | `outcome: {done}` or `{dropped, failure_class, reason}` | task reached terminal status.                                                  |
| `finalize-terminal` | `run_status: "completed"\|"failed"\|"superseded"`       | run finalized. Terminal by construction.                                       |

Build results only via the constructors (`advance`, `spawn`, `gracefulStop`,
`waitRetry`, `taskDone`, `taskDropped`, `finalizeTerminal`) so the shape never drifts.

### 3.3 The four load-bearing invariants (verified)

1. **Unknown `kind` THROWS — never silent-advance.** Every `switch` over `kind`
   ends in `default: assertNever(...)` (compile-time exhaustiveness + runtime throw).
   Holds in `checkResult`, `nextStageFor`, `isTerminalResult`.
2. **`wait-retry` is bounded.** `attempt > max_attempts` throws — the engine cannot spin.
3. **`finalize` is terminal-by-construction.** A run-level stage may return **only**
   `finalize-terminal`; any other kind throws. Symmetrically a per-task stage may
   **never** return `finalize-terminal`. `decideFinalize` throws on a non-terminal
   task (never returns `wait-retry`) — the structural fix for the bash exit-3
   finalize spin-bug. Rollup (Decision 34 — whole-PRD delivery only): all tasks
   `done` → `completed`; any task not `done` (dropped, etc.) or 0 tasks → `failed`.
4. **derive-don't-store** (see §2.5) — defense-in-depth so a TCB write-gap is
   non-load-bearing.

### 3.4 `SpawnManifest` (Zod) — structured spawn payload

```ts
SpawnRole = "test-writer" | "executor"
          | "implementation-reviewer" | "quality-reviewer"
          | "architecture-reviewer" | "security-reviewer"
          | "silent-failure-hunter" | "type-design-reviewer"
          | "scribe"
SpawnAgent = { role: SpawnRole; isolation: "worktree"|"none"(=worktree); model: string; max_turns: number>0; prompt_ref: string }
SpawnManifest = { stage_after: TaskStage; agents: SpawnAgent[] (min 1) }
parseSpawnManifest(raw): SpawnManifest   // LOUD on unknown role / bad stage / empty agents
```

Validated as Zod so the **v2 Workflow driver** consumes it as structured output —
no exit codes, no reading `state.json` for control flow.

### 3.5 The engine (pure) + handler seam

```ts
interface StageContext  { readonly run: RunState; readonly task?: TaskState; readonly attempt?: number }
interface StageHandlers { preflight/tests/exec/verify/ship/finalize(ctx): Promise<StageResult> }

runStage(stage, ctx, handlers): Promise<StageResult>   // dispatch → ONE exhaustiveness check
nextStageFor(result): TaskStage | null                 // shared transition logic (advance→.to, spawn→.stage_after, else null)
decideFinalize(run): FinalizeTerminalResult            // pure rollup; throws on non-terminal task
new StageEngine(handlers).run(stage, ctx) / .nextStageFor(result)
```

The engine **does not** shell out, read/write state, sleep, or loop. Handlers
(WS3/6/7/8) do the work; the **driver** (WS10) acts on the result. This is what
makes the seam structured-output-expressible for the v2 driver.

---

## 4. Boundaries Group-1 must respect

- Import only from `src/types`. Do not deep-import `src/core/*`.
- Do not add a `StageResult.kind`, a `SpawnRole`, or an enum member without a
  decision — every consumer switches exhaustively and a new member is a deliberate
  compile-break across the codebase (that is the point).
- Handlers are **pure-ish reporters**: read `StageContext`, return a `StageResult`.
  They never write state (the driver owns the `StateManager` write) and never
  decide transitions (`nextStageFor` does).
- Never obtain a gate verdict except through a `derive*` accessor. There is no
  stored boolean to read.
- Validate any untrusted input with the `parse*` entry points, never bare `.parse`.
