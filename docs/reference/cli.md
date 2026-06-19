# CLI Reference

The `factory` CLI is the deterministic engine — it owns ALL pipeline control
flow and exposes exactly ONE seam, the **coroutine** (`next` + `drive`). Every
subcommand prints exactly one JSON document to stdout (or `--summary` human text
for `state`); `--help` on any subcommand prints its contract. The binary is
`dist/factory.js`, reached on `PATH` as `factory` via the `bin/factory` shim.

Subcommands are **reporters** (read-only; emit an envelope), **the coroutine** (`next`
folds nothing; `drive --results` folds an agent spawn's output into ONE state
step), or **writers** (one state mutation). `run create`, `run finalize`, `run cancel`,
`scaffold`, and the coroutine's `drive` ship step perform actions (state and/or GitHub
side effects). The coroutine is the only seam that spawns nothing itself — it emits a
manifest the driver spawns from (see [Model A](../explanation/model-a.md)).

Run/spec state is read from and written to `$CLAUDE_PLUGIN_DATA`.

## Global behavior

- No args / `--help` / `-h` → prints the registry, exits `0`.
- Unknown subcommand → stderr message, exits `2` (USAGE).
- A subcommand's own usage error → exits `2`; any other error → exits `1`.
- `run create` against an already-active run → exits `3` (CONFLICT) — see
  [`run create`](#run-create).

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
(`.stryker.config.json`, `.dependency-cruiser.cjs`, `eslint.config.mjs`); ensures
the `.gitignore` guard; and probes branch protection on `develop` (the integration
base) — **refusing loudly** when `develop` is not protected, unless `--provision` is
set. Per-run `staging-<run-id>` branches are minted at [`run create`](#run-create);
scaffold no longer creates or protects a shared `staging` branch.

```
factory scaffold [--repo <owner/name>] [--provision]
```

| Flag                  | Required | Notes                                                                                                                                                        |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--repo <owner/name>` | no       | Target GitHub repo (used for the protection probe). Auto-derived from the `origin` remote when omitted; an explicit value that disagrees with it fails loud. |
| `--provision`         | no       | Write branch protection if missing (default: refuse).                                                                                                        |

Emits a `ScaffoldReport`: `{ repo, files_created, files_present, files_updated,
files_outdated, protection, settings }`.

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

## `run <create|resume|finalize|cancel>`

### `run create`

Action. Resolves a durable spec, creates a fresh run, seeds one `pending` task per
spec task, cuts + GitHub-protects the run's `staging-<run-id>` integration branch
from `develop` (Decision 33), and emits `{kind:"created", run}`. Seeding copies only
the producer dial (`risk_tier`) + dependency edges — never `tdd_exempt` (read from
the spec at runtime). Duplicate, self, dangling, or cyclic dependency edges fail
loudly at seed time.

```
factory run create [--repo <owner/name>] (--issue <n> | --spec-id <id>) [--run-id <id>]
                   [--new] [--supersede | --resume] [--workflow] [--no-ship] [--session-id <id>]
```

| Flag                  | Notes                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--repo <owner/name>` | **Optional.** Repo identity (the first key of the spec store). Auto-derived from the `origin` remote when omitted; an explicit value that disagrees with the remote fails loud.                                                                                   |
| `--issue <n>`         | PRD issue number — the stable lookup key. One of `--issue`/`--spec-id`.                                                                                                                                                                                           |
| `--spec-id <id>`      | Explicit `<issue>-<slug>` spec id. Mutually exclusive with `--issue`.                                                                                                                                                                                             |
| `--run-id <id>`       | Override the generated `run-YYYYMMDD-HHMMSS` id (determinism/tests). A named id forces a fresh create.                                                                                                                                                            |
| `--new`               | Force a fresh run, bypassing the active-run conflict scan.                                                                                                                                                                                                        |
| `--supersede`         | If an active run exists for this spec, mark it `superseded`, delete its `staging-<run-id>` branch (auto-closing its task PRs), then create a fresh run. Emits `{kind:"superseded", run, supersededId}`. Mutually exclusive with `--resume`.                       |
| `--resume`            | If an active run exists, do not create — return the conflict (exit `3`) so the caller hands off to [`resume`](#resume). Mutually exclusive with `--supersede`.                                                                                                    |
| `--workflow`          | Run the parallel background Workflow driver. **Default (omit): session** — sequential, quota-paced, in-session agents. Persisted as `mode` (`workflow` disables pacing — hard-stop).                                                                              |
| `--no-ship`           | Open the task/rollup PRs but never merge. **Default (omit): live** — serial-merge each task into the run's `staging-<run-id>` branch and the rollup into develop. Persisted as `ship_mode` so the workflow driver + resume + finalize read it without re-passing. |
| `--session-id <id>`   | Owning Claude Code session id for the session-scoped Stop gate. Defaults to `$CLAUDE_CODE_SESSION_ID`; absent ⇒ owner-unknown (gate runs unscoped).                                                                                                               |

**Autonomy gate (mandatory, no opt-out):** `run create` HALTS loud (`NotAutonomousError`,
exit 1) unless the session is autonomous (`FACTORY_AUTONOMOUS_MODE=1`). The pipeline runs
unattended by design; `/factory:run` calls [`factory autonomy preflight`](#autonomy-preflight)
first, which auto-scaffolds and prints the `claude --settings <merged-settings.json>` relaunch
command when needed (`ensure`/`status` remain the manual primitives). See
[Decision 29](../explanation/decisions.md#decision-29-autonomy-is-mandatory--enforced-in-the-engine-no-opt-out)
and [Decision 31](../explanation/decisions.md#decision-31-run-entry-preflight-auto-scaffolds-autonomous-settings).

Loud error if no spec exists for the issue — generate one first. The seeded run's
`driver` is fixed to `sequential`: the v1 coroutine seam drives tasks one at a time.
The persisted `mode` (`session`|`workflow`) selects which _driver_ steps the seam;
`/factory:run` forwards its own `--workflow` flag here (see
[Run the pipeline](../guides/run-the-pipeline.md)).

**Active-run conflict (Decision 35 — no silent reuse).** A PRD has at most one active
run at a time. `run create` does **not** reuse an existing run: when a non-terminal
run already exists for this `(repo, spec_id)`, it exits `3` (CONFLICT) and emits
`{kind:"exists", existing:{run_id, status}}`. Two escapes resolve the conflict:

- `--supersede` — mark the old run `superseded`, delete its `staging-<run-id>` branch
  - PRs, and create a fresh run (`{kind:"superseded", run, supersededId}`).
- `--resume` — return the conflict so the caller hands off to [`resume`](#resume).

`--new` (or an explicit `--run-id`) bypasses the conflict scan and forces a fresh
run unconditionally. The scan→create is serialized under a per-`(repo, spec_id)` lock
so two concurrent same-spec creates cannot both mint an orphan. `--resume` simply
reports the conflict (`kind:"exists"`) for the caller to hand off to [`resume`](#resume);
it does **not** validate the create-time `--workflow`/`--no-ship` flags against the live
run — flag-compatibility belongs to the resume hand-off, not a premature gate here, so a
resumed run keeps its own persisted dials regardless. Emits `{kind:"created", run}` on
the fresh-create path.

### `run resume`

Thin CLI alias of the top-level [`resume`](#resume) command, kept for one release.
Prefer `factory resume`.

```
factory run resume [--run <id>]
```

### `run finalize`

Action. Turns an all-terminal run into its shipped outcome, in resume-safe order:
build the report (`report.md`), emit telemetry, file one GitHub issue per dropped
task (deduped), then — **only when the run completed** (Decision 34: develop receives
whole PRDs only) — forward-reconcile `develop` into the run branch (no force-push),
open + CI-gate + (in `live` mode) squash-merge the `staging-<run-id> → develop`
rollup, comment on + close the originating PRD issue, and delete the per-run branch;
finally flip the run terminal **last**. A `failed` run leaves `develop` untouched,
the PRD open, and keeps its branch for rescue. Loud if any task is still non-terminal.
Idempotent (a re-entered finalize re-files nothing).

```
factory run finalize [--run <id>] [--no-ship]
```

Ship mode defaults to the run's **persisted `ship_mode`** (set at `run create`); no flag
is needed. `--no-ship` overrides it to no-merge for THIS finalize only (opens the
`staging-<run-id> → develop` rollup PR but never merges). Emits
`{kind:"finalized", run, report, rollup?, issues_filed}`.

### `run cancel`

Action. **Abandons a live run** so its owning session can stop — the in-session escape
from the Stop gate (Decision 35 addendum). Marks the run terminal by reusing `failed`,
via `state.finalize` **directly** (NOT the `run finalize` ship path): no rollup CI, no
merge, no PRD close. Because `finalize` validates only that the _target_ status is
terminal — never the task statuses — a run with a task still `executing` is cancellable
(the same mechanism `--supersede` uses). Idempotent for `failed`; a run already terminal
as `completed`/`superseded` is a loud error. A cancelled run is **not resumable** — start
fresh with `/factory:run`.

```
factory run cancel [--run <id>] [--cleanup] [--session-id <id>]
```

| Flag                | Notes                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--run <id>`        | The run to cancel. Default: the active run THIS session owns (`findActiveByOwner`, robust to a detached `runs/current`), then the current run for the checkout. Loud if none resolves. |
| `--cleanup`         | Also tear down the run's PINNED `staging-<run-id>` branch + its task PRs (protection first, then the branch — GitHub blocks deleting a protected ref). **Default (omit): leave them.** |
| `--session-id <id>` | Owning session id used to locate the run when `--run` is omitted. Defaults to `$CLAUDE_CODE_SESSION_ID`.                                                                               |

Unlike `run create`/`resume`, cancel has **no autonomy gate** — it is the documented exit
from the Stop gate and must work from any session. Emits `{kind:"cancelled", run, cleaned_up}`.

## `resume`

Action (Decision 35 — a top-level verb, distinct from `run`/`rescue`/`debug`).
Re-checks the live quota window and resumes a paused/suspended run if the binding
window recovered. Reads nothing else; leaves state untouched when blocked. A terminal
run is a loud error (nothing to resume). `factory run resume` is a thin alias of this
command.

```
factory resume [--run <id>]
```

Subject to the same mandatory autonomy gate as `run create` (halts loud unless
`FACTORY_AUTONOMOUS_MODE=1`).

`--run` defaults to **this repo's current run** — resolved from the caller's
checkout (`origin` remote → `<dataDir>/current/<repoKey>`), falling back to the
legacy global pointer when the repo can't be derived (see
[Per-repo current](#per-repo-current-run-resolution)). Emits one of:

- `{kind:"resumed", run}` — window recovered (or the run was already running).
- `{kind:"still-blocked", run_id, status, reason, resets_at_epoch?}` — not
  recovered; state untouched.

## `state`

Reporter (read-only). Prints run state.

```
factory state                 # current run's state.json (JSON)
factory state <run-id>        # that run's state.json (JSON)
factory state --summary       # compact human summary
```

No current run is not an error: prints `{"current": null}` (or `no current run`
with `--summary`) and exits `0`. State corruption is loud.

With no `<run-id>`, the current run is resolved **per repo** from the caller's
checkout — see below. `score`, `rescue`, and `resume` resolve the same way.

### Per-repo current run resolution

The human reporters/actions that default to "the current run" (`state`, `score`,
`rescue`, `resume`) resolve it **per repo** from the shell's cwd, so two runs
in two different checkouts don't shadow each other:

1. derive the repo from the checkout's `origin` remote;
2. read `<dataDir>/current/<repoKey>` → that repo's current run;
3. if the repo can't be derived (no `origin`), fall back to the legacy global
   `runs/current` (the repo-less "most recent") — degrade-safe, never an error.

`--run <id>` always wins over this resolution; `drive` ignores it entirely
(always requires `--run`). `next` is the one exception — it stays on the global
`runs/current` + `--assert-owner` mechanism (see [`next`](#the-coroutine-next--drive)),
because the drivers always pass `--run` to it explicitly. This is CLI ergonomics
only: the hooks no longer read the global pointer at all (Decision 30), so
concurrency-correctness does not depend on it.

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
factory next [--run <id>]                          # defaults to runs/current
factory next --assert-owner <session>              # loud-assert runs/current ownership
factory next --expect-mode <session|workflow>      # loud-assert runs/current mode
```

`--assert-owner <session>` and `--expect-mode <mode>` are opt-in guards for the
workflow driver's first `next` (which adopts `runs/current` rather than
passing `--run`), defending against a concurrent `run create` having redirected
`runs/current` onto a foreign run:

- `--assert-owner <session>` throws loud if the resolved run's persisted
  `owner_session` disagrees with `<session>`. The driver passes
  `"$CLAUDE_CODE_SESSION_ID"`, which is session-scoped and inherited identically by
  the exec-agent, so it equals the stamped owner on the happy path. Degrades safe
  (no assertion) when either side is unknown.
- `--expect-mode <mode>` throws loud if the resolved run's `mode` differs — a
  propagation-independent guard (no env assumptions) that catches a concurrent
  session-mode create redirecting the pointer. An invalid value is a usage error.

Manual `factory next` never needs either. Both run only on the `runs/current` path;
the explicit `--run <id>` path bypasses them.

Every envelope also carries the self-resolved run context (`run_id`, canonical
`data_dir`, `ship_mode`) so the workflow driver adopts them from the first `next`.

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

`--ship-mode` (`no-merge` | `live`) is the internal-seam override the drivers pass
machine-side; omit it to honor the run's persisted `ship_mode` (users never type it —
the user-facing knob is `--no-ship` on `run create`/`run finalize`). Emits one of:

- `{ kind:"spawn", run_id, task_id, stage, fold_key, manifest, sidecar?, expects, worktree, base_ref }`
  — the agents to run (`manifest.agents`) and what to feed back. `stage` is one of
  `tests | exec | verify` (preflight only advances; ship never spawns). `expects`
  is `producer-status` (tests/exec — one producer agent) or `reviews` (verify —
  the six-reviewer panel); a `sidecar` accompanies `verify` when a holdout answer
  key was withheld. `worktree` is the task working tree the agents commit in.
  `base_ref` is the per-run staging base that worktree forked from
  (`origin/staging-<run-id>`); the panel and holdout sidecar diff against THIS, never
  a bare `origin/staging` (which namespace-collides after a repo branch rename). Its
  branch is resolved via `resolveStagingBranch(run_id, run.staging_branch)` — the name
  pinned in `RunState` at create ([state model](./state-model.md#runstate)), not
  recomputed — so it stays fixed to the branch already pushed to origin even if the
  naming scheme changes mid-run.
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

Recover a stalled run that `resume` cannot untangle (resume only clears the
quota gate; it never touches task state). The `/factory:rescue` command pairs these
subcommands with the `rescue-reconciler` agent (git/GitHub drift repair) before
handing off to [`resume`](#resume) — see
[Rescue a stalled run](../guides/rescue-a-stalled-run.md).

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

## `autonomy <ensure|status|preflight>`

Autonomous mode is **mandatory** for a run (`run create`/`resume` halt without it —
[Decision 29](../explanation/decisions.md#decision-29-autonomy-is-mandatory--enforced-in-the-engine-no-opt-out)). These verbs set it up and check it. `preflight` is the **run-entry composer** `/factory:run` calls; `ensure`/`status` are the manual primitives.

### `autonomy ensure`

Writer (default verb). Materializes the merged settings file an autonomous (headless) relaunch
runs under. Merges `templates/settings.autonomous.json` with your existing
user settings into `${CLAUDE_PLUGIN_DATA}/merged-settings.json`: placeholders
(`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}`) substituted, `env.CLAUDE_PLUGIN_DATA`
baked, `permissions.allow` unioned (template wins on other keys), and the
`statusLine` wired to `factory statusline`. If your own (non-factory) `statusLine`
is present it is preserved by chaining it through `FACTORY_ORIGINAL_STATUSLINE`;
a stale chain value is dropped. Then prints the relaunch command.

```
factory autonomy ensure [--user-settings <path>]
```

| Flag                     | Required | Notes                                                                   |
| ------------------------ | -------- | ----------------------------------------------------------------------- |
| `--user-settings <path>` | no       | Override the user-settings source (default: `~/.claude/settings.json`). |

Prints a human-readable relaunch message to stdout that includes the command
`claude --settings <merged-settings.json>` — not a `{kind:…}` envelope.

### `autonomy status`

Reporter. Reports whether the current session satisfies the autonomy gate. **Exits 0
when autonomous, 1 when not — and never throws** (it is the diagnostic you run precisely
when the gate has halted you).

```
factory autonomy status [--json]
```

| Flag     | Required | Notes                                          |
| -------- | -------- | ---------------------------------------------- |
| `--json` | no       | Emit the machine-readable payload (see below). |

`--json` emits `{ autonomous, envSet, mergedSettingsPresent, mergedSettingsPath }`:
`autonomous` is the gate predicate (`FACTORY_AUTONOMOUS_MODE === "1"`); `envSet`
distinguishes an unset var from a wrong value; `mergedSettingsPresent`/`mergedSettingsPath`
report whether the `ensure` output exists and where.

### `autonomy preflight`

Composer — the run-entry check `/factory:run` (and `/factory:debug`) calls at the top of
setup ([Decision 31](../explanation/decisions.md#decision-31-run-entry-preflight-auto-scaffolds-autonomous-settings)).
It restores the old auto-scaffold convenience: rather than merely halting and telling you to
run `ensure` yourself, it **decides** whether the run may proceed and (re)scaffolds for you
when it can't.

```
factory autonomy preflight [--user-settings <path>]
```

The verdict is a pure function of three inputs — is this session autonomous, does
`merged-settings.json` exist, and does its stamped `_factoryVersion` match the installed
plugin version:

| Autonomous? | Settings file | Version           | Outcome                                                       |
| ----------- | ------------- | ----------------- | ------------------------------------------------------------- |
| no          | (any)         | (any)             | **regenerate + halt** (`missing-settings` / `not-autonomous`) |
| yes         | absent        | —                 | **proceed** (`ci-raw-env` — env exported directly)            |
| yes         | present       | match             | **proceed** (`fresh`)                                         |
| yes         | present       | differ            | **regenerate + halt** (`stale-version`)                       |
| yes         | present       | unstamped         | **regenerate + halt** (`unstamped`)                           |
| yes         | present       | plugin unknowable | **proceed** (`version-unknowable` — no churn)                 |

On a halt it delegates to `ensure` (the single writer path) to (re)materialize the settings,
prints the same `claude --settings <merged-settings.json>` relaunch block plus a one-line
reason, and **exits 1**. On proceed it writes nothing and **exits 0**. Like `status`, it is
infallible on the decision path (an unresolvable data/root dir degrades to a halt-with-message,
never a throw). The relaunch itself is irreducible — Claude Code reads settings only at launch,
so a running session can never make _itself_ autonomous; preflight automates the scaffold, not
the relaunch. The mandatory-autonomy engine gate (`requireAutonomousMode`, Decision 29) stays as
the correctness backstop behind it.

| Flag                     | Required | Notes                                                             |
| ------------------------ | -------- | ----------------------------------------------------------------- |
| `--user-settings <path>` | no       | Override the user-settings source passed through to a regenerate. |

## `statusline`

Side-effecting passthrough — NOT a machine subcommand. Wire it as the Claude Code
`statusLine.command`. Claude Code pipes a JSON payload to stdin on every statusline
tick; this subcommand:

1. reads the whole stdin payload (may be empty / non-JSON),
2. if it carries `.rate_limits`, atomically persists `rate_limits + {captured_at}`
   to `${CLAUDE_PLUGIN_DATA}/usage-cache.json` — the ONLY producer of the cache the
   session-mode quota pacer (`StatuslineUsageSignal`) reads,
3. passes the SAME payload through to `$FACTORY_ORIGINAL_STATUSLINE` (if set) and
   forwards ITS stdout as the displayed statusline (with a 3s timeout).

```
factory statusline
```

IO contract: stdout is the DISPLAYED statusline text (passthrough), never a
`{kind:…}` envelope. Fail-soft invariant: the statusline fires constantly and must
never crash — every degraded condition (empty/non-JSON stdin, no `rate_limits`,
unresolvable data dir, a broken/slow original command) is a clean no-op returning
exit 0. Diagnostics go to stderr.
