---
name: debug
description: (internal) Drive /factory:debug — the whole-scope review⇄fix loop. The `factory debug <start|review|spec|seed|finalize>` CLI owns every decision (base resolution, adjudication, pass ownership, finalize); you spawn what each envelope names and feed results back, exactly like skills/pipeline-runner/SKILL.md.
auto-invoke: false
---

# Debug — the /factory:debug whole-scope review⇄fix loop

`/factory:debug` runs the SAME risk-invariant judgment layer the per-task merge gate
uses (citation-verify → independent finding-verifier → per-reviewer adjudication),
applied to a **whole-scope diff** (`--base`/`--full` .. `HEAD`) instead of one task's
diff. Confirmed blockers are rendered into a synthetic PRD and driven through the
**ordinary** `factory spec` / `factory next-task` / `factory next-action` machinery —
so a debug pass is executed by the SAME producer⇄reviewer loop `/factory:run` uses,
just seeded from a review report instead of a GitHub issue. `factory debug
<start|review|spec|seed|finalize>` is the deterministic seam
(`src/cli/subcommands/debug.ts`); you are the same "dumb loop" role
`skills/pipeline-runner/SKILL.md` describes — you never decide a transition, you
spawn exactly what an envelope names and feed the raw results back.

<EXTREMELY-IMPORTANT>
## Iron Law

1. **`factory debug spec` is sound ONLY after a `{kind:"findings"}` review-record
   result.** Never call `debug spec resolve|gate|store` after a `{kind:"clean"}`
   result — a clean pass has zero confirmed blockers, so the synthetic PRD it would
   render (`"(no confirmed blockers)"`) can never pass the spec gate's traceability
   check (Task 6 report, "Issues or concerns"). `clean` branches straight to
   **finalize** (step 6) and STOPS.
2. **`next-task`'s `"finalize"` kind during a debug run means "this pass is done, go
   re-review" — it is NEVER a signal to call `factory run finalize`.** Only step 6's
   clean/cap branch calls the ONE real finalize, `factory debug finalize`, exactly
   once per session. See "Finalize interception" below — this is the single most
   important deviation from `skills/pipeline-runner/SKILL.md`'s Phase 3 loop.

Violating the letter of this rule violates the spirit. No exceptions.
</EXTREMELY-IMPORTANT>

## Iron Laws

1. **Never decide a transition.** The only next action is what the last envelope
   said. You never edit session/state JSON, never re-order steps, never re-run a
   step to "check" (identical to `skills/pipeline-runner/SKILL.md`).
2. **Spawn exactly what the manifest says; collect output verbatim.** Role, model,
   `max_turns`, isolation per `skills/pipeline-runner/SKILL.md`'s Agent spawn
   matrix — reused unchanged, not re-derived here.
3. **Fail loud.** An unknown envelope `kind`, an unexpected non-zero exit, or a
   `debug spec`/`debug seed` LOUD `Error` (e.g. "run 'debug review --record'
   first") → STOP and surface it verbatim. Never blind-retry.
4. **`session.base` never moves.** It is set once at `start`; every pass reviews
   the SAME `base..HEAD` range on the SAME debug staging branch, so later passes
   naturally see fewer residual findings as fixes land.

## Autonomy check (precondition for all numbered steps)

Identical mechanics to `/factory:run`'s Phase 0 step 2 (`factory autonomy
preflight`) — reused unchanged, just repositioned as this skill's own first step
since `/factory:debug` is a standalone entry point, not a sub-phase of the run
skill:

```bash
factory autonomy preflight   # exits 0 to proceed, 1 to halt
```

It auto-scaffolds `merged-settings.json` when the session is not autonomous OR the
settings are stale/missing/unstamped, and prints the relaunch command. The pipeline
runs unattended — `debug start` HALTS loud otherwise (same `src/autonomy/mode.ts`
gate `run create` uses). On a non-zero exit, relay the printed `claude --settings
<merged-settings.json>` command to the user and **stop** — the relaunch is the
user's irreducible step. `factory autonomy status`/`ensure` remain the manual
primitives (see `/factory:run`'s "Autonomous mode" section for the full mechanics —
not duplicated here).

## Step 1 — `factory debug start`

```bash
factory debug start [--base <hash> | --full] [--no-ship] [--author-e2e] \
  [--max-passes <n>] --session-id "$CLAUDE_CODE_SESSION_ID"
```

- `--base <hash>` / `--full` are mutually exclusive (`--full` diffs against the git
  empty-tree SHA `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, i.e. review the ENTIRE
  tree); omit both for the default `HEAD~1`. Passing both throws a `UsageError`
  ("debug start: pass exactly one of --base or --full").
- `--no-ship` persists no-merge ship mode on the eventual debug `RunState` (default:
  live). `--author-e2e` persists `e2e:true` on it (opt into the e2e-authoring
  phase during the task loop, step 5). Neither takes effect until `seed` (step 4)
  actually creates the run.
- `--max-passes <n>` caps review⇄fix passes before the driver must stop looping
  (default 5; must be a positive integer or `debug start` throws).
- Always pass `--session-id "$CLAUDE_CODE_SESSION_ID"` (falls back to the env var
  itself if omitted) — same ownership rationale as `run create` in
  `skills/pipeline-runner/SKILL.md`'s Phase 2.

Mints the run id, cuts the debug staging branch (the SAME `ensureStaging` +
`runStagingBranch` mechanism `run create` uses), and emits:

```json
{ "kind": "review", "run_id": "<id>", "base": "<resolved base>", "worktree": "<cwd>", "pass": 1 }
```

No `RunState` exists yet — a debug run is born later, at `seed` (step 4). Record
`run_id` and `worktree` (the checkout you are already running in — debug does NOT
cut a separate worktree per pass); every subsequent action takes `--run <run_id>`.
Proceed to step 2.

## Step 2 — Review a pass: `factory debug review --emit` / `--record`

### 2a. Emit the panel manifest

```bash
factory debug review --emit --run <run_id>
```

Emits:

```json
{
  "kind": "review-spawn",
  "run_id": "<id>",
  "pass": <n>,
  "manifest": { "resume_phase": "verify", "agents": [ /* 7 panel roles */ ] },
  "base": "<resolved base>",
  "worktree": "<cwd>",
  "codex_available": true | false
}
```

`manifest` is `buildPanelManifest("verify", <reviewModel>, <maxTurnsDeep>)` —
**identical construction** to the per-task verify phase's panel (Δ T/Δ K: the panel
is risk-invariant, same model + turn budget for every reviewer, no debug-specific
variant). Its `agents` array is the SAME fixed 7-role
`PANEL_ROLES` (`src/verifier/judgment/panel.ts`) `skills/pipeline-runner/SKILL.md`'s
per-task "Panel" step spawns:

- `implementation-reviewer`, `quality-reviewer`, `architecture-reviewer`,
  `security-reviewer`, `silent-failure-hunter`, `type-design-reviewer`,
  `systemic-failure-reviewer`.

**Spawn all 7 in one assistant message** (parallel), isolation `"worktree"`, model
mapped per the manifest agent's `model` field (per
`skills/pipeline-runner/SKILL.md`'s Agent spawn matrix / model-alias table). Before
spawning, each reviewer's prompt is built INLINE from that role's `agents/<role>.md`
definition PLUS the shared `skills/review-protocol/SKILL.md` contract — there is no
per-run prompt file to Read (`prompt_ref` is a schema placeholder, never a real
artifact; see `panel.ts`'s `promptRefFor` doc comment). Tell each reviewer to
inspect via `git -C <worktree> diff <base>` (the envelope's `base`/`worktree`
verbatim) and emit exactly one RawReview JSON per `skills/review-protocol/SKILL.md`'s
output contract: `{ reviewer, verdict: "approve"|"blocked"|"error", findings: [
{ reviewer, severity, blocking, file, line, quote, description } ] }`.

**Cross-vendor (Codex).** `codex_available` is the CLI's own resolution
(`config.codex.model !== undefined` — a config-presence check, not a live probe;
`src/cli/subcommands/debug.ts`'s `debugReviewEmit`) — read it off THIS envelope,
never re-derive it. `skills/pipeline-runner/SKILL.md` does not document a separate
runner-side Codex spawn for the per-task panel either (the panel's 7 roles are
ALL Claude agents; a second vendor participates only via the finding-verifier's
identity, below) — debug follows the identical convention: `codex_available` governs
ONLY whether you omit or include `crossVendorAbsent` in the `--results` file
(2b, below), never an extra manifest entry.

**Verify-then-fix.** For EVERY finding any reviewer marked `blocking: true` AND
citable (`file`+`line` both present), spawn an INDEPENDENT finding-verifier —
`general-purpose`, isolation `"worktree"`, model `opus`, adversarial framing ("does
this finding hold against the code?"), inspecting via `git -C <worktree> diff <base>` —
per `skills/pipeline-runner/SKILL.md`'s "Collecting a spawn envelope" →
`expects: "reviews"` step 3, reused verbatim (not re-derived here). It returns
`{ "holds": true|false, "note": "<why>" }`.

### 2b. Record the results

Write EXACTLY this shape (identical to `RecordReviewsInput` /
`skills/pipeline-runner/SKILL.md`'s per-task results file, minus the `holdout` key —
a whole-scope pass has no sidecar/holdout-validator step):

```json
{
  "reviews": [ /* each panel reviewer's raw RawReview JSON, verbatim */ ],
  "verifications": [
    { "reviewer": "<role>", "verdicts": [ { "file", "line", "holds", "note" } ] }
  ],
  "crossVendorAbsent": { "reason": "no second-vendor reviewer configured" }
}
```

Omit `crossVendorAbsent` entirely when `codex_available` was `true`; include it
(with that exact reason string) when it was `false`. Include one verdict for every
blocking+citable finding — the CLI fails closed on a missing one.

```bash
factory debug review --record --run <run_id> --results <path-to-above-file>
```

Emits ONE of:

- `{ "kind": "clean", "run_id", "pass" }` — zero confirmed blockers (review
  findings AND the repo's COMMITTED e2e suite are folded into the SAME check via
  `foldE2eIntoBlockers` — "confirmed blocker" already means "review OR e2e").
  **Go straight to step 6 (finalize). Do NOT call `debug spec`.**
- `{ "kind": "findings", "run_id", "pass", "report_path", "confirmed_count" }` —
  ≥1 confirmed blocker, written to `report_path` (a markdown findings write-up
  under `<dataDir>/debug/<run-id>/pass-<n>/findings.md`).
  - If `pass == maxPasses` (from `debug start`'s `--max-passes`, tracked by you —
    the CLI does not itself compare `pass` to the cap): **go straight to step 6
    (finalize)**, reporting `report_path`'s residual findings as unresolved. STOP.
  - Else: continue to step 3 (the spec sub-loop).

## Step 3 — Spec sub-loop: `factory debug spec resolve|gate|store`

Only reachable from a `findings` result with `pass < maxPasses` (Iron Law 1). Same
generate⇄review mechanics as `skills/pipeline-runner/SKILL.md`'s Phase 1 (spec-generator
/ spec-reviewer, the SAME `agents/spec-generator.md` / `agents/spec-reviewer.md`,
the SAME `max_iterations` bound) — only the CLI subcommand differs
(`debug spec` vs `spec`) and the seed is a synthetic PRD rendered from this pass's
confirmed blockers instead of a fetched GitHub PRD:

```bash
env = factory debug spec resolve --run <run_id>
loop on env.kind:
  reuse   → a durable spec already exists for this pass's synthetic issue number
            (`DEBUG_ISSUE_BASE + pass`) — call `factory debug spec store --run
            <run_id>` once anyway (idempotent) so `session.specId` is persisted;
            only `store`'s `kind:"stored"` branch writes it (`resolve`'s `reuse`
            envelope does NOT touch the session — see `debugSpecStore`'s doc
            comment). Then go to step 4 (seed).
  generate → remember env.max_iterations
      spawn spec-generator (worktree, opus) with env.spawn.context embedded
      write its GenerateResult JSON verbatim to env.generated_path
      env = factory debug spec gate --run <run_id>
  revise  → (count iterations; > max_iterations → STOP LOUD, spec-defect)
      spawn spec-generator (worktree, opus) with env.spawn.context embedded
      (context already carries the prior spec + blockers — PATCH, don't re-author)
      write its GenerateResult JSON verbatim to env.generated_path
      env = factory debug spec gate --run <run_id>
  review  → spawn spec-reviewer (worktree, opus) with env.spawn.context embedded
      write its ReviewVerdict JSON to env.verdict_path
      env = factory debug spec store --run <run_id>
  stored  → session.specId persisted (debugSpecStore's side effect on
            kind:"stored"). Go to step 4 (seed).
```

Every `debug spec` action's envelope is the SAME `SpecBuildEnvelope` union `factory
spec`'s actions return (`src/cli/subcommands/spec.ts`) — `resolve`/`gate`/`store`
are thin pass-throughs fed a `SpecBuildDeps` swapped to a network-free `GhClient`
that returns the synthetic PRD instead of shelling out to `gh` (`debugRepo` still
auto-derives `owner/name` from the checkout's `origin` remote, exactly like real
`factory spec`). `debug spec resolve|gate|store` is LOUD (`Error`, not
`UsageError`) if `review --record` has not run yet this pass — "run 'debug review
--record' first".

## Step 4 — `factory debug seed`

```bash
factory debug seed --run <run_id>
```

**Pass ownership (load-bearing — read this before touching `pass` anywhere):**
`session.pass` names the round CURRENTLY being reviewed/fixed. Steps 2 and 3 read
it as-is and never change it. `seed` is the ONLY action that advances it — pass 1:
creates the real `RunState` (`debug:true`, `intent:"fresh"`, `ship_mode`/`e2e` from
`debug start`'s `--no-ship`/`--author-e2e`) via the UNCHANGED `createRun`. Pass > 1:
appends the pass's fix tasks onto the SAME run's existing tasks
(`appendTasksFromSpec`). Either way, `seed` writes `pass: pass+1` into the session
BEFORE returning — so your NEXT `debug review --emit` call (once this pass's tasks
are terminal) naturally reviews as the next pass without any separate "advance"
action. Never increment `pass` yourself; never call `seed` a second time for the
same pass.

Emits `{ "kind": "loop", "run_id": "<id>" }`. Proceed to step 5.

## Step 5 — Drive the task loop (THE LOOP, reused)

Drive `run_id` through `skills/pipeline-runner/SKILL.md`'s Phase 3 THE LOOP
EXACTLY as written there — `factory next-task` / `factory next-action`, the
`expects: "producer-status"` / `expects: "reviews"` spawn collection, the Agent
spawn matrix, the `e2e`/`document` stage handling if `--author-e2e` was set — none
of it is re-derived here. **One deviation, called out on its own because getting it
wrong ships nothing or ships too early:**

### Finalize interception (the ONE deviation from Phase 3)

```
loop:
  env = factory next-task --run <run_id>
  case env.kind:
    "finalize" → this pass's tasks are ALL terminal. Do NOT run `factory run
                 finalize`. Go back to step 2 (factory debug review --emit) to
                 re-review base..HEAD now that this pass's fixes have landed.
    "done"   → (should not occur mid-debug-session before a "finalize"; treat
                 identically to "finalize" above if it ever does — same
                 interception)
    "e2e" / "document" / "pause" / "work" → EXACTLY as Phase 3 describes.
```

`next-task` has no idea it is driving a debug session — it emits `"finalize"`
whenever a run's tasks are all terminal, debug or not (`src/orchestrator/next.ts`).
The ONLY thing that makes a debug session different is that YOU intercept that
signal here instead of calling `factory run finalize`. Only step 6's clean/cap
branch (from step 2) ever calls the real finalize — `factory debug finalize`.

## Step 6 — `factory debug finalize` (the one real finalize)

Reached ONLY from step 2's `clean` branch, or step 2's `findings` branch when
`pass == maxPasses`. Called EXACTLY ONCE per debug session:

```bash
factory debug finalize --run <run_id> [--no-ship]
```

Mirrors `run.ts`'s `runFinalize` byte-for-byte (`loadCliDeps` → `finalizeRun`,
UNCHANGED — just re-emitted under debug's own envelope kind). Emits:

```json
{
  "kind": "finalized",
  "run": {
    /* RunState */
  },
  "report": {
    /* PartialRunReport */
  },
  "rollup": {
    /* RollupResult, optional */
  },
  "failure_comment_posted": false
}
```

`failure_comment_posted` is always `false` for a debug run — `finalizeRun` skips
the PRD-facing failure comment and the completed-rollup PRD comment/close for
`run.debug === true` runs (Decision 39's deferred-finalize guards, Task 4): a debug
session has no real PRD issue to comment on or close, only its own staging
branch/PR. The rollup PR itself (staging → the base branch) is still opened/merged
normally — that PR **is** `/factory:debug`'s one deliverable.

## Report

Surface: run id, base, pass count reached, final `kind` (`clean` vs
`findings`-at-cap), the rollup PR (or "no-ship: PRs left open" if `--no-ship`), and
— on a cap-out — the last pass's `report_path` so residual findings are visible.
`factory state <run_id> --summary` gives the same shape `skills/pipeline-runner/SKILL.md`'s
Phase 4 reads for `/factory:run`; reuse it here too.

## When NOT to use this skill

- CLI/internal questions or debugging the factory plugin itself → regular tools.
- Driving `/factory:run`'s normal PRD→PR pipeline → `skills/pipeline-runner/SKILL.md`.
- A finished debug session → `factory state`; nothing to resume (debug's
  session-resume story is a documented known gap — see CLAUDE.md).
