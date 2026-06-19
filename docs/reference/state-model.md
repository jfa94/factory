# State Model

All run and spec state lives **outside** the target repo, under the plugin data
dir (`$CLAUDE_PLUGIN_DATA`, resolved by `src/config`). This is a hard requirement:
the holdout answer-key must be unreadable from an executor worktree, so state
cannot live in-repo. Defined in `src/core/state/`.

## Two stores

```
$CLAUDE_PLUGIN_DATA/
├── specs/<repo-key>/<spec-id>/        # DURABLE spec store — reused across runs
├── spec-build/<repo-key>/<issue>/     # TRANSIENT spec-build scratch
│   └── {prd,generated,verdict}.json
├── current/<repo-key>                # symlink → that repo's current run (CLI-only)
├── worktrees/<run-id>/<task-id>/     # producer worktrees (write-scope ownership)
└── runs/
    ├── current                        # legacy global pointer (repo-less "most recent")
    └── <run-id>/
        ├── state.json                 # the RunState
        ├── audit.jsonl                # append-only audit log
        ├── metrics.jsonl              # append-only telemetry
        ├── report.md                  # finalize/partial report
        ├── holdouts/                  # withheld answer-keys + verdicts
        └── reviews/                   # reviewer artifacts
```

- **Durable spec store** — `specs/<repo-key>/<spec-id>/`, keyed by `(repo,
spec-id)` where `spec-id = "<issue>-<slug>"`. The PRD issue number is the stable
  lookup key, so re-running a PRD issue resolves the same spec. Reused across runs.
- **Transient spec-build scratch** — `spec-build/<repo-key>/<issue>/`, a
  discardable handoff buffer for one generate/review loop (keyed by issue, since no
  spec-id exists yet).
- **Ephemeral run store** — `runs/<run-id>/`, one per run.
- **Per-repo current pointer** — `current/<repo-key>` → `../runs/<run-id>`, in a
  tree **separate** from `runs/` so `listRuns` (which scans `runs/` only) is
  untouched. It's CLI ergonomics only — the human reporters resolve "the current
  run" per repo from the caller's checkout (Decision 30). `run create` writes both
  this and the legacy global `runs/current`; `pointCurrentAt` refuses loud (before
  any write) to repoint a repo whose current names a still-live run owned by a
  different known session (the new run stays addressable via `--run`). No hook
  reads either pointer.
- **Producer worktrees** — `worktrees/<run-id>/<task-id>/`, a sibling of `runs/`
  and `specs/`. The producer (test-writer / executor) edits here; because the
  path encodes `(run-id, task-id)`, the write-scope guard derives run ownership
  straight from a write's absolute target path (Decision 30, [hooks](./hooks.md#run-ownership)).

`<repo-key>` is a sanitized single path segment derived from `owner/name` (the
slash and any unsafe char folded to `-`; a pure-dot path-traversal segment is
rejected). The same sanitizer keys both `specs/` and `current/`.

## Writes are atomic and locked

Every state mutation goes through the `StateManager` (`manager.ts`) — the only
sanctioned write path. Writes are atomic (write-temp-then-rename) and
lock-protected (`proper-lockfile`).

## No stored verdicts (derive-don't-store)

The schema deliberately has **no field** holding a gate pass/fail boolean. Every
gate / panel / floor verdict is re-derived from ground truth at the moment it is
needed (`derive.ts`), so there is structurally nothing in state to forge. The one
stored judgment is each reviewer's panel verdict (the reviewer's opinion is itself
ground truth); the _floor_ (unanimity) is derived from those. See
[../explanation/derive-dont-store.md](../explanation/derive-dont-store.md).

## `RunState`

`runs/<run-id>/state.json`. Schema in `src/core/state/schema.ts`. Validate
untrusted input with `parseRunState` (it layers the run-level cross-field check),
never `RunStateSchema.parse` directly.

| Field                       | Type                       | Meaning                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`            | `1`                        | State-schema version (forward-migration marker).                                                                                                                                                                                                                                                                                                                                  |
| `run_id`                    | string                     | `run-YYYYMMDD-HHMMSS`.                                                                                                                                                                                                                                                                                                                                                            |
| `status`                    | RunStatus                  | See below.                                                                                                                                                                                                                                                                                                                                                                        |
| `driver`                    | `sequential \| balanced`   | The driver preset that produced this run.                                                                                                                                                                                                                                                                                                                                         |
| `mode`                      | `session \| workflow`      | Execution mode (default `session`). Persisted at create; selects which driver steps the seam and gates quota pacing (workflow = no pacing).                                                                                                                                                                                                                                       |
| `ship_mode`                 | `no-merge \| live`         | Ship mode (default `live` — auto-merge; `--no-ship` opts into `no-merge`). Persisted at create so the workflow driver / `resume` / `finalize` read it without re-passing.                                                                                                                                                                                                         |
| `owner_session`             | string?                    | Owning Claude Code session id (best-effort). Scopes the Stop gate; absent ⇒ owner-unknown (gate runs unscoped).                                                                                                                                                                                                                                                                   |
| `staging_branch`            | string?                    | The run's integration branch, **pinned once at create** (`staging-<run-id>`). Identity/provenance, not a derived verdict — read everywhere via `resolveStagingBranch(run_id, staging_branch)` ([Decision 33](../explanation/decisions.md#decision-33-per-run-staging-branch-replaces-the-single-shared-staging-branch)). Legacy runs without it fall back to the recomputed name. |
| `spec`                      | SpecPointer                | Pointer to the durable spec (not an embedded spec).                                                                                                                                                                                                                                                                                                                               |
| `tasks`                     | record<task_id, TaskState> | Per-task state.                                                                                                                                                                                                                                                                                                                                                                   |
| `quota`                     | QuotaCheckpoint?           | Resume checkpoint; present _iff_ paused/suspended.                                                                                                                                                                                                                                                                                                                                |
| `started_at` / `updated_at` | string                     | ISO-8601.                                                                                                                                                                                                                                                                                                                                                                         |
| `ended_at`                  | string \| null             | ISO-8601, null until terminal.                                                                                                                                                                                                                                                                                                                                                    |

### `RunStatus`

| Value        | Terminal? | Meaning                                                                                                                           |
| ------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `running`    | no        | Actively executing.                                                                                                               |
| `paused`     | no        | Quota 5h-window breach; waiting out the curve in-session, self-heals.                                                             |
| `suspended`  | no        | Quota 7d-window breach; state persisted, process exited cleanly; resume continues from checkpoint.                                |
| `completed`  | yes       | Every task done, rollup CI green; `staging-<run-id> → develop` merged, PRD closed, per-run branch deleted (success).              |
| `failed`     | yes       | A task was dropped, or the run could not start / wedged (circuit breaker). `develop` untouched, PRD open, branch kept for rescue. |
| `superseded` | yes       | A fresh run replaced this one; its `staging-<run-id>` branch + PRs were deleted.                                                  |

`develop` receives a run's work **only as a whole PRD** (Decision 34) — there is no
`partial` status. `paused`/`suspended` are **quota** states; `completed`/`failed`/
`superseded` are the terminal **outcomes** — they must stay distinct.

### `SpecPointer`

`{ repo, spec_id, issue_number }` — a run points at its spec, it does not embed
one.

## `TaskState`

| Field                     | Type                       | Meaning                                                        |
| ------------------------- | -------------------------- | -------------------------------------------------------------- |
| `task_id`                 | string                     | —                                                              |
| `status`                  | TaskStatus                 | See below.                                                     |
| `depends_on`              | string[]                   | Task ids this task depends on (the vertical-slice DAG).        |
| `risk_tier`               | `low \| medium \| high`    | The single producer dial, set at spec time, never re-assessed. |
| `escalation_rung`         | int ≥0                     | Current rung on the producer escalation ladder (0 = starting). |
| `producer_role`           | `test-writer \| executor`? | Which producer role is/last ran.                               |
| `reviewers`               | ReviewerResult[]           | Per-reviewer panel results (the floor is derived from these).  |
| `branch`                  | string?                    | Run-scoped branch `factory/<run_id>/<task_id>`.                |
| `pr_number`               | int >0?                    | PR number once created.                                        |
| `failure_class`           | FailureClass?              | Set _iff_ `status === "dropped"`.                              |
| `failure_reason`          | string?                    | Human-facing drop reason; set _iff_ dropped.                   |
| `stage`                   | TaskStage?                 | The drive coroutine's resume cursor (see below).               |
| `merge_resyncs`           | int ≥0 (default 0)         | Ship live-merge re-sync count (see below).                     |
| `started_at` / `ended_at` | string?                    | ISO-8601.                                                      |

### `TaskStatus`

| Value       | Terminal? | Meaning                                                                |
| ----------- | --------- | ---------------------------------------------------------------------- |
| `pending`   | no        | Not started, or blocked on an unsatisfied dependency.                  |
| `executing` | no        | A producer stage (test-writer / executor) is in flight.                |
| `reviewing` | no        | The verifier floor (gates + panel) is in flight.                       |
| `shipping`  | no        | Verified; PR open / merging into the run's `staging-<run-id>` branch.  |
| `done`      | yes       | Merged into `staging-<run-id>` (success).                              |
| `dropped`   | yes       | Ladder exhausted; a classified loud drop (pairs with `failure_class`). |

### `FailureClass`

A closed set (adding one is a design change):

| Class                   | Meaning                                                                    |
| ----------------------- | -------------------------------------------------------------------------- |
| `capability-budget`     | The producer could not meet the bar within the escalation ladder's budget. |
| `spec-defect`           | The failure is in the spec/target itself (e.g. an untestable criterion).   |
| `blocked-environmental` | An external blocker (CI infra, network, a missing dependency).             |

### `ReviewerResult`

`{ reviewer, verdict (approve|blocked|error), artifact?, confirmed_blockers }`.
Cross-field coherence is enforced: `approve ⇒ 0` confirmed blockers; `blocked ⇒
≥1`; `error` is unconstrained.

### `stage` — the drive coroutine's resume cursor

`"preflight" | "tests" | "exec" | "verify" | "ship"` (optional). The precise
machine cursor for `factory drive`: which stage the task is at, or resuming at.
The drive coroutine reads it to resume after a crash; it is written by `markInFlight`.

- The lossy `status` (executing / reviewing / shipping …) stays the **human-facing**
  summary; `stage` is the **machine cursor**.
- **Absent** = not started — the coroutine resumes at `preflight`.
- On a **terminal** row (`done` / `dropped`), `stage` holds the _last in-flight
  stage_, not a resume point — terminal writers do not clear it.

(The literals duplicate the stage machine's `TASK_STAGE_ORDER` deliberately, so
`src/core/state` need not import the stage machine; a cross-check test keeps them
equal.)

### `merge_resyncs` — ship live-merge re-sync budget

`int ≥0` (default `0`). The number of times the task's `ship` stage refused a live
merge and re-routed back through `exec` to re-sync. The drive coroutine enforces the cap
(`MERGE_RESYNC_CAP`) and persists the count so the budget survives process
boundaries; exhausting it drops the task as `blocked-environmental`.

## `QuotaCheckpoint`

`{ resets_at_epoch?, binding_window?: "5h"|"7d" }` — the minimal state a resumable
run persists. Present _iff_ the run is `paused` or `suspended`; resume must clear
it before returning to `running`.
</content>
