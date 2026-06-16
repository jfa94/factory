# CLI Reference

The `factory` CLI is the deterministic engine — it owns ALL pipeline control
flow and exposes exactly ONE seam, the **coroutine** (`next` + `drive`). Every
subcommand prints exactly one JSON document to stdout (or `--summary` human text
for `state`); `--help` on any subcommand prints its contract. The binary is
`dist/factory.js`, reached on `PATH` as `factory` via the `bin/factory` shim.

Subcommands are **reporters** (read-only; emit an envelope), **the coroutine** (`next`
folds nothing; `drive --results` folds an agent spawn's output into ONE state
step), or **writers** (one state mutation). `run create`, `run finalize`,
`scaffold`, and the coroutine's `drive` ship step perform actions (state and/or GitHub
side effects). The coroutine is the only seam that spawns nothing itself — it emits a
manifest the driver spawns from (see [Model A](../explanation/model-a.md)).

Run/spec state is read from and written to `$CLAUDE_PLUGIN_DATA`.

## Global behavior

- No args / `--help` / `-h` → prints the registry, exits `0`.
- Unknown subcommand → stderr message, exits `2` (USAGE).
- A subcommand's own usage error → exits `2`; any other error → exits `1`.

See [exit-codes.md](./exit-codes.md).

---

## `config-defaults`

Reporter. Prints the fully resolved config (defaults + any `config.json` overlay)
as JSON. Doubles as a smoke test of the config loader.

```
factory config-defaults
```

## `configure`

Inspect or edit the persisted config overlay. Every edit round-trips through the
schema before it touches disk; an invalid value is a loud error, never persisted.
Writes are a sparse overlay, so future default changes stay visible.

```
factory configure                          # print the resolved config
factory configure --get <key.path>         # print one resolved value
factory configure --set <key.path=value>   # set (repeatable), validate, persist
factory configure --unset <key.path>       # revert a key to its default (repeatable)
```

Values parse as JSON when possible (numbers, booleans, arrays), else as a bare
string. `--get` cannot be combined with `--set`/`--unset`. Example:
`factory configure --set quality.holdoutPercent=25`. Keys are in
[configuration.md](./configuration.md).

## `scaffold`

Action. Prepares a target repo for the pipeline: idempotently copies the CI net
(`.github/workflows/quality-gate.yml`) and, for Node packages, the gate configs
(`.stryker.config.json`, `.dependency-cruiser.cjs`); ensures the `.gitignore`
guard; ensures the staging branch (from the base branch, never `main`); and
probes branch protection — **refusing loudly** when the staging branch is not
protected, unless `--provision` is set.

```
factory scaffold --repo <owner/name> [--provision]
```

| Flag                  | Required | Notes                                                 |
| --------------------- | -------- | ----------------------------------------------------- |
| `--repo <owner/name>` | yes      | Target GitHub repo; used for the protection probe.    |
| `--provision`         | no       | Write branch protection if missing (default: refuse). |

Emits a `ScaffoldReport`: `{ repo, files_created, files_present, staging,
protection }`.

## `spec <resolve|gate|store>`

Reporter. The deterministic spec-build seam. The spec pipeline needs two agent
spawns (spec-generator + spec-reviewer), which the orchestrator owns; the CLI owns
the deterministic glue. State is threaded through a transient scratch dir
(`spec-build/<repo>/<issue>/{prd,generated,verdict}.json`). Each action takes
`--repo` + `--issue` and emits one envelope naming the next step.

```
factory spec resolve --repo <owner/name> --issue <n>
factory spec gate    --repo <owner/name> --issue <n>
factory spec store   --repo <owner/name> --issue <n>
```

- **resolve** — reuse an existing spec for the issue (`{kind:"reuse", pointer}`),
  else fetch the PRD and emit the generate spawn (`{kind:"generate", spawn,
prd_path, generated_path, max_iterations}`).
- **gate** — run the deterministic spec gates over the generator output; emit
  `{kind:"revise", source:"gate", blockers, …}` on a block, else the review spawn
  (`{kind:"review", spawn, verdict_path, …}`).
- **store** — adjudicate the review (single 56/60 threshold + any-dimension floor);
  emit `{kind:"revise", source:"review", …}` on NEEDS_REVISION, else persist and
  emit `{kind:"stored", pointer}`.

The orchestrator loops generate ⇄ review (bounded by `max_iterations`) until
`reuse` or `stored`.

## `run <create|resume|finalize>`

### `run create`

Action. Resolves a durable spec, creates a fresh run, seeds one `pending` task per
spec task, and emits the `RunState`. Seeding copies only the producer dial
(`risk_tier`) + dependency edges — never `tdd_exempt` (read from the spec at
runtime). Duplicate, self, dangling, or cyclic dependency edges fail loudly at
seed time.

```
factory run create --repo <owner/name> (--issue <n> | --spec-id <id>) [--run-id <id>]
```

| Flag                  | Notes                                                                   |
| --------------------- | ----------------------------------------------------------------------- |
| `--repo <owner/name>` | Repo identity (the first key of the spec store). Required.              |
| `--issue <n>`         | PRD issue number — the stable lookup key. One of `--issue`/`--spec-id`. |
| `--spec-id <id>`      | Explicit `<issue>-<slug>` spec id. Mutually exclusive with `--issue`.   |
| `--run-id <id>`       | Override the generated `run-YYYYMMDD-HHMMSS` id (determinism/tests).    |

Loud error if no spec exists for the issue — generate one first. The seeded run's
`driver` is fixed to `sequential`: the v1 coroutine seam drives tasks one at a time.
(The `--mode session|workflow` knob on `/factory:run` selects which _driver_
steps the seam — not a CLI flag here; see [Run the pipeline](../guides/run-the-pipeline.md).)

### `run resume`

Action. Re-checks the live quota window and resumes a paused/suspended run if the
binding window recovered. Reads nothing else; leaves state untouched when blocked.
A terminal run is a loud error (nothing to resume).

```
factory run resume [--run <id>]
```

`--run` defaults to `runs/current`. Emits one of:

- `{kind:"resumed", run}` — window recovered (or the run was already running).
- `{kind:"still-blocked", run_id, status, reason, resets_at_epoch?}` — not
  recovered; state untouched.

### `run finalize`

Action. Turns an all-terminal run into its shipped outcome, in resume-safe order:
build the partial report (`report.md`), emit telemetry, file one GitHub issue per
dropped task (deduped), open + CI-gate + (in `live` mode) squash-merge the
`staging → develop` rollup, then flip the run terminal **last**. Loud if any task
is still non-terminal. Idempotent (a re-entered finalize re-files nothing).

```
factory run finalize [--run <id>] [--ship-mode <mode>]
```

`--ship-mode`: `no-merge` (default — opens the rollup PR, never merges) | `live`.
Emits `{kind:"finalized", run, report, rollup?, issues_filed}`.

## `state`

Reporter (read-only). Prints run state.

```
factory state                 # current run's state.json (JSON)
factory state <run-id>        # that run's state.json (JSON)
factory state --summary       # compact human summary
```

No current run is not an error: prints `{"current": null}` (or `no current run`
with `--summary`) and exits `0`. State corruption is loud.

## The coroutine (`next` + `drive`)

The coroutine is the engine's single control-flow seam. `next` is the **run-level**
coroutine (which task is ready); `drive` is the **task-level** coroutine (run one task's
deterministic steps until it needs agents). A driver — the in-session orchestrator
loop or the Workflow script (see [Run the pipeline](../guides/run-the-pipeline.md))
— alternates them: `next` to pick a task, `drive` to advance it, spawn the agents
the manifest names, then `drive --results` to fold their output back. Neither coroutine
spawns anything itself.

The six retired single-step writers — `run-task`, `advance`, `drop`,
`record-producer`, `record-holdout`, `record-reviews` — collapsed into the coroutine.
Their fold logic now runs inside `drive --results` (`src/driver/fold.ts`); the
producer / holdout / reviews folds are no longer separate CLI calls.

## `next`

Reporter (run-level coroutine). One run-loop step: terminal check, quota gate
(persisting a pause/suspend checkpoint on breach), stale-checkpoint clear on
recovery, transitive cascade-drop of tasks blocked on an unsatisfiable dependency,
then the ready set. Writes only on a quota breach or a cascade-drop; otherwise
read-only. Throws LOUD on a dependency deadlock.

```
factory next [--run <id>]      # defaults to runs/current
```

Emits one of:

- `{ kind:"tasks-ready", run_id, ready:[...], cascade_dropped:[...] }` — ready
  tasks, **in-flight first** (crash-resume finishes started work before opening
  new), then pending in spec order.
- `{ kind:"all-terminal", run_id, cascade_dropped:[...] }` — nothing left to
  schedule; the driver calls `factory run finalize` next. `cascade_dropped` is
  this-invocation-only.
- `{ kind:"run-terminal", run_id, run_status }` — the run is already terminal.
- `{ kind:"quota-blocked", run_id, scope, reason, resets_at_epoch? }` — a quota
  window blocked; the checkpoint is persisted.

## `drive`

The per-task coroutine (the engine seam both drivers share). Resumes at the task's
persisted `stage` cursor, optionally folds the previous spawn's agent results
(`--results`), then runs every deterministic stage it can until it needs agents or
the task is terminal. Emits ONE JSON `DriveEnvelope`.

```
factory drive --run <id> --task <id> [--results <file>] [--ship-mode <mode>]
```

`--ship-mode`: `no-merge` (default) | `live`. Emits one of:

- `{ kind:"spawn", run_id, task_id, stage, fold_key, manifest, sidecar?, expects, worktree }`
  — the agents to run (`manifest.agents`) and what to feed back. `stage` is one of
  `tests | exec | verify` (preflight only advances; ship never spawns). `expects`
  is `producer-status` (tests/exec — one producer agent) or `reviews` (verify —
  the six-reviewer panel); a `sidecar` accompanies `verify` when a holdout answer
  key was withheld. `worktree` is the task working tree the agents commit in.
- `{ kind:"terminal", run_id, task_id, outcome }` — the task is `done` or a
  classified `dropped`.
- `{ kind:"quota-blocked", run_id, task_id, scope, reason, resets_at_epoch? }`.

**The `--results` fold.** `--results <file>` feeds back exactly what the previous
spawn envelope's `expects` named, and folds it into ONE state step (advance, bump
the producer rung, or terminal). The file MUST echo the envelope's `fold_key`
verbatim:

```
expects=producer-status → { "fold_key": {…}, "producer": { "status": "<STATUS line>" } }
expects=reviews         → { "fold_key": {…}, "holdout"?: { "raw": "<validator output>" },
                            "reviews": { reviews, verifications, crossVendorAbsent? } }
```

The fold is **at-least-once delivery, exactly-once application**: the `fold_key`
(`{stage, rung}`) is validated against the live cursor before any mutation, so a
stale or duplicate delivery is rejected LOUD rather than double-folded. On a
rejection, re-invoke **without** `--results` to re-derive the current spawn
envelope (re-invoking without results is idempotent). The `reviews` fold runs the
full verify floor internally — re-runs the deterministic gates, re-derives the
persisted holdout evidence, citation-verifies the reviews against the worktree,
and confirms each surviving blocker via the supplied `verifications` (a kept
citable blocker with no recorded verdict fails closed). Holdout is folded **before**
reviews. A refused live merge re-routes the task through `exec` to re-sync, bounded
by a persisted per-task budget (`merge_resyncs`).

## `score`

Reporter (read-only). Resolves the run + its spec, derives the partial report, and
emits the compact `RunSummary`. `--dead-surface` additionally enumerates
unreferenced exports in the run diff (report-only, best-effort; a probe failure
degrades to an `error` entry rather than crashing).

```
factory score [--run <id>] [--dead-surface] [--base <ref>] [--project-root <dir>]
```

`--base` (default `origin/<git.baseBranch>`) and `--project-root` (default cwd)
tune the `--dead-surface` scan. Emits `{ kind:"score", summary, dead_surface? }`.

## `rescue <scan|apply>`

Recover a stalled run that `run resume` cannot untangle (resume only clears the
quota gate; it never touches task state).

### `rescue scan`

Reporter (read-only). Classifies every task and reports what a re-drive would do.

```
factory rescue scan [--run <id>]
```

Emits a `RescueScan`: `{ run_id, run_status, counts, resettable, dead_ends,
needs_rescue, would_deadlock, summary, tasks }`. Dispositions: `shipped`,
`runnable`, `stuck` (crashed in-flight), `recoverable` (`blocked-environmental`
drop), `dead-end` (`spec-defect`/`capability-budget` drop). Default-resettable =
`stuck ∪ recoverable`.

### `rescue apply`

Writer. Resets the resettable tasks to `pending` and reopens a terminal run.

```
factory rescue apply [--run <id>] [--task <id>]... [--include-dead-ends]
```

| Flag                  | Notes                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--task <id>`         | Reset exactly this task (repeatable). Overrides the default set; a `done` task is a loud error, a `pending` one is skipped; a named dead-end IS reset. |
| `--include-dead-ends` | Also reset dead-end drops. Use only after the root cause is fixed.                                                                                     |

Default (no `--task`): resets `stuck` + `recoverable`, leaving dead-ends dropped;
reopens a terminal run to `running` when it reset work. Idempotent. Emits
`{ run_id, run_status, reset, reopened, skipped }`.
</content>
