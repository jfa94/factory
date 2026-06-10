# CLI Reference

The `factory` CLI is the deterministic engine. Every subcommand prints exactly
one JSON document to stdout (or `--summary` human text for `state`); `--help` on
any subcommand prints its contract. The binary is `dist/factory.js`, reached on
`PATH` as `factory` via the `bin/factory` shim.

Subcommands are **reporters** (read-only; emit an envelope) or **writers** (one
state mutation). `run create`, `run finalize`, `scaffold`, and
`run-task --stage ship` perform actions (state and/or GitHub side effects).

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
factory run create --repo <owner/name> (--issue <n> | --spec-id <id>) [--driver <d>] [--run-id <id>]
```

| Flag                  | Notes                                                                   |
| --------------------- | ----------------------------------------------------------------------- |
| `--repo <owner/name>` | Repo identity (the first key of the spec store). Required.              |
| `--issue <n>`         | PRD issue number — the stable lookup key. One of `--issue`/`--spec-id`. |
| `--spec-id <id>`      | Explicit `<issue>-<slug>` spec id. Mutually exclusive with `--issue`.   |
| `--driver <d>`        | `sequential` \| `balanced` (default `balanced`).                        |
| `--run-id <id>`       | Override the generated `run-YYYYMMDD-HHMMSS` id (determinism/tests).    |

Loud error if no spec exists for the issue — generate one first.

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

## `run-task`

Reporter (single-step). Runs exactly one stage's deterministic work and emits one
envelope. The orchestrator performs any agent spawn and folds the outcome via the
`record-*` writers.

```
factory run-task --run <id> --task <id> --stage <stage> [--ship-mode <mode>]
```

Stages: `preflight | tests | exec | verify | ship`. `--ship-mode`:
`no-merge` (default) | `live`.

Envelope: `{ run_id, task_id, stage, stage_result, sidecar? }`.

- `preflight | tests | exec | verify` — pure report (no run-state write). `verify`
  additionally surfaces a holdout-validate `sidecar` when an answer key was
  withheld and the panel is being spawned this round.
- `ship` — the one stage that writes state: opens the PR idempotently, records
  branch/pr_number, optionally serial-merges (`live`), and on a clean `done`
  writes the terminal task status. A refused live merge emits a `wait-retry`.

The `stage_result.kind` is one of `advance | spawn-agents | task-terminal |
wait-retry`.

## `advance`

Writer. Persists the in-flight cursor for the next stage (status + `started_at`).
Use after a `run-task` result of `{kind:"advance", to}`. Writes only the cursor —
no domain transition.

```
factory advance --run <id> --task <id> --to <stage>
```

Emits `{ run_id, task_id, step: { done:false, stage } }`.

## `record-producer`

Writer. Folds a producer spawn's terminal STATUS line into state via the shared
ladder logic: on `done` advances to the next stage; a classified failure bumps the
rung (resume at the same producer stage) or drops (`capability-budget`) when the
ladder is exhausted.

```
factory record-producer --run <id> --task <id> --stage <tests|exec> --status "<line>"
```

`--status` is the agent's terminal STATUS line (e.g. `STATUS: DONE`,
`STATUS: BLOCKED — escalate`, `STATUS: NEEDS_CONTEXT`). Emits `{ run_id, task_id,
step }`.

## `record-holdout`

Writer. Folds the out-of-band holdout-validator output: parses the verdicts
(fail-closed on unparseable output — every withheld criterion scores as a fail),
persists them (read back by `record-reviews`), and emits the derived holdout gate
evidence.

```
factory record-holdout --run <id> --task <id> --input <path>
```

`--input` is `{ "raw": "<validator output>" }`. Loud error if the task has no
withheld answer key. Emits `{ run_id, task_id, evidence, check }`. Must run
**before** `record-reviews`.

## `record-reviews`

Writer. Folds the panel + verify-then-fix verdicts into the floor, fully
deterministically (no spawn): re-runs the deterministic gates, re-derives the
persisted holdout evidence, citation-verifies the reviews against the worktree,
confirms each surviving blocker via the orchestrator's pre-recorded verdicts (a
kept citable blocker with no recorded verdict fails closed), derives the floor,
persists the per-reviewer results, and acts via the shared ladder.

```
factory record-reviews --run <id> --task <id> --input <path>
```

`--input` is `{ "reviews": [...], "verifications": [{reviewer, verdicts:[...]}],
"crossVendorAbsent"?: {reason} }`. Emits `{ run_id, task_id, step, reviewers,
floor }`.

## `drop`

Writer. Applies an explicit, classified loud drop through the same shared
`dropStep` as the derived drops — so a drop is always classified and reasoned,
never silent. The orchestrator's manual drop path.

```
factory drop --run <id> --task <id> --class <failure-class> --reason "<text>"
```

Failure classes: `capability-budget | spec-defect | blocked-environmental`. Emits
`{ run_id, task_id, step: { done:true, outcome:{ outcome:"dropped",
failure_class, reason } } }`.

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
