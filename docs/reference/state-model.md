# State Model

All run and spec state lives **outside** the target repo, under the plugin data
dir (`$CLAUDE_PLUGIN_DATA`, resolved by `src/config`). This is a hard requirement:
the holdout answer-key must be unreadable from an implementer worktree, so state
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
  and `specs/`. The producer (test-writer / implementer) edits here; because the
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
gate / panel / merge gate verdict is re-derived from ground truth at the moment it is
needed (`derive.ts`), so there is structurally nothing in state to forge. The one
stored judgment is each reviewer's panel verdict (the reviewer's opinion is itself
ground truth); the _merge gate_ (unanimity) is derived from those. See
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
| `runner`                    | `sequential \| balanced`   | The runner preset that produced this run.                                                                                                                                                                                                                                                                                                                                         |
| `mode`                      | `session \| workflow`      | Execution mode (default `session`). Persisted at create; selects which runner steps the seam and gates quota pacing (workflow = no pacing).                                                                                                                                                                                                                                       |
| `ship_mode`                 | `no-merge \| live`         | Ship mode (default `live` — auto-merge; `--no-ship` opts into `no-merge`). Persisted at create so the workflow runner / `resume` / `finalize` read it without re-passing.                                                                                                                                                                                                         |
| `owner_session`             | string?                    | Owning Claude Code session id. Scopes the Stop / SubagentStop gates (resolved via `findActiveByOwner`). **Required for session-mode runs** (an ownerless session-mode `run create` is rejected); only workflow-mode runs may persist it absent. An absent owner means no run is attributed to a stopping session, so the gate passes through (allow).                             |
| `staging_branch`            | string?                    | The run's integration branch, **pinned once at create** (`staging-<run-id>`). Identity/provenance, not a derived verdict — read everywhere via `resolveStagingBranch(run_id, staging_branch)` ([Decision 33](../explanation/decisions.md#decision-33-per-run-staging-branch-replaces-the-single-shared-staging-branch)). Legacy runs without it fall back to the recomputed name. |
| `spec`                      | SpecPointer                | Pointer to the durable spec (not an embedded spec).                                                                                                                                                                                                                                                                                                                               |
| `tasks`                     | record<task_id, TaskState> | Per-task state.                                                                                                                                                                                                                                                                                                                                                                   |
| `ignore_quota`              | boolean                    | When `true`, the quota gate is skipped unconditionally for this run — both orchestrators + runners read it from state (no per-call threading), mirroring the `mode==="workflow"` skip. Set at create from `--ignore-quota`, or toggled true by `factory resume --ignore-quota`. Default `false`; a legacy run without the field reads as `false`.                                 |
| `quota`                     | QuotaCheckpoint?           | Resume checkpoint; present _iff_ paused/suspended.                                                                                                                                                                                                                                                                                                                                |
| `docs`                      | DocsStage?                 | Documentation-phase marker; absent until the engine docs phase runs ([Decision 37](../explanation/decisions.md#decision-37--documentation-is-an-engine-phase-before-finalize)).                                                                                                                                                                                                   |
| `started_at` / `updated_at` | string                     | ISO-8601.                                                                                                                                                                                                                                                                                                                                                                         |
| `ended_at`                  | string \| null             | ISO-8601, null until terminal.                                                                                                                                                                                                                                                                                                                                                    |

### `RunStatus`

| Value        | Terminal? | Meaning                                                                                                                                                                                                          |
| ------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running`    | no        | Actively executing.                                                                                                                                                                                              |
| `paused`     | no        | Quota 5h-window breach; waiting out the curve in-session, self-heals.                                                                                                                                            |
| `suspended`  | no        | Quota 7d-window breach; state persisted, process exited cleanly; resume continues from checkpoint.                                                                                                               |
| `completed`  | yes       | Every task done, rollup CI green; `staging-<run-id> → develop` merged, PRD closed, per-run branch deleted (success).                                                                                             |
| `failed`     | yes       | A task was failed, the run could not start / wedged (circuit breaker), or the operator abandoned it via `factory run cancel`. `develop` untouched, PRD open, branch kept for rescue (unless `cancel --cleanup`). |
| `superseded` | yes       | A fresh run replaced this one; its `staging-<run-id>` branch + PRs were deleted.                                                                                                                                 |

`develop` receives a run's work **only as a whole PRD** (Decision 34) — there is no
`partial` status. `paused`/`suspended` are **quota** states; `completed`/`failed`/
`superseded` are the terminal **outcomes** — they must stay distinct.

### `SpecPointer`

`{ repo, spec_id, issue_number }` — a run points at its spec, it does not embed
one.

## `TaskState`

| Field                     | Type                          | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `task_id`                 | string                        | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `status`                  | TaskStatus                    | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `depends_on`              | string[]                      | Task ids this task depends on (the vertical-slice DAG). A deliberate denormalization: copied from the `SpecTask` at seed time and then frozen, so DAG-traversal readers (ready-task selection, rescue drift-scan) read edges off run state without coupling to the spec store.                                                                                                                                                                                           |
| `escalation_rung`         | int ≥0                        | Current rung on the producer escalation ladder (0 = starting).                                                                                                                                                                                                                                                                                                                                                                                                           |
| `producer_role`           | `test-writer \| implementer`? | Which producer role is/last ran.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `test_revision_feedback`  | string?                       | The implementer's defect reason on a `test-defective` recovery (a wrong RED test, [Decision 38](../explanation/decisions.md#decision-38--defective-red-test-recovery-the-implementer-reports-it-the-test-writer-regenerates-it)). Set when the implementer raises `test requires revision`; injected into the regenerating test-writer's prior-failure context; cleared once the test-writer returns `done`. **Transient — not a failure field; allowed on any status.** |
| `reviewers`               | ReviewerResult[]              | Per-reviewer panel results (the merge gate is derived from these).                                                                                                                                                                                                                                                                                                                                                                                                       |
| `branch`                  | string?                       | Run-scoped branch `factory/<run_id>/<task_id>`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `pr_number`               | int >0?                       | PR number once created.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `failure_class`           | FailureClass?                 | Set _iff_ `status === "failed"`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `failure_reason`          | string?                       | Human-facing fail reason; set _iff_ failed.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `phase`                   | TaskStage?                    | The drive orchestrator's resume cursor (see below).                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `merge_resyncs`           | int ≥0 (default 0)            | Ship live-merge re-sync count (see below).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `spawn_in_flight`         | object?                       | Spawn-in-flight checkpoint for idempotent re-spawn (see below).                                                                                                                                                                                                                                                                                                                                                                                                          |
| `started_at` / `ended_at` | string?                       | ISO-8601.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

`TaskState` stores **no** `risk_tier`. The single producer dial (`low | medium |
high`, set at spec time and never re-assessed mid-run) lives on the `SpecTask` and
is read live via the spec pointer — never copied into run state (derive-don't-store,
Decision 25). On-disk state written before this change still parses: the schema
strips the now-unknown key, and `schema_version` is unchanged.

### `TaskStatus`

| Value       | Terminal? | Meaning                                                                |
| ----------- | --------- | ---------------------------------------------------------------------- |
| `pending`   | no        | Not started, or blocked on an unsatisfied dependency.                  |
| `executing` | no        | A producer phase (test-writer / implementer) is in flight.             |
| `reviewing` | no        | The merge gate (gates + panel) is in flight.                           |
| `shipping`  | no        | Verified; PR open / merging into the run's `staging-<run-id>` branch.  |
| `done`      | yes       | Merged into `staging-<run-id>` (success).                              |
| `failed`    | yes       | Ladder exhausted; a classified loud fail (pairs with `failure_class`). |

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

### `phase` — the drive orchestrator's resume cursor

`"preflight" | "tests" | "exec" | "verify" | "ship"` (optional). The precise
machine cursor for `factory next-action`: which phase the task is at, or resuming at.
The drive orchestrator reads it to resume after a crash; it is written by `markInFlight`.

- The lossy `status` (executing / reviewing / shipping …) stays the **human-facing**
  summary; `phase` is the **machine cursor**.
- **Absent** = not started — the orchestrator resumes at `preflight`.
- On a **terminal** row (`done` / `failed`), `phase` holds the _last in-flight
  stage_, not a resume point — terminal writers do not clear it.

(The literals duplicate the phase machine's `TASK_PHASE_ORDER` deliberately, so
`src/core/state` need not import the phase machine; a cross-check test keeps them
equal.)

### `merge_resyncs` — ship live-merge re-sync budget

`int ≥0` (default `0`). The number of times the task's `ship` phase refused a live
merge and re-routed back through `exec` to re-sync. The drive orchestrator enforces the cap
(`MERGE_RESYNC_CAP`) and persists the count so the budget survives process
boundaries; exhausting it fails the task as `blocked-environmental`.

### `spawn_in_flight` — idempotent re-spawn checkpoint

`{ phase: "tests"|"exec"|"verify", rung: int ≥0, tip_sha: string }` (optional). The
checkpoint that makes a stop-mid-spawn plus `factory resume` idempotent. Producers
commit to the **shared** task worktree, so a stop in the post-spawn / pre-record
window leaves the abandoned producer's partial commits (and uncommitted edits) on
the task branch.

- **Set on a fresh spawn.** When the orchestrator emits a spawn for `(phase, rung)`, it
  records the task-branch `tip_sha` at emit time.
- **Reset on a matching re-spawn.** When a resume re-enters the **same** `(phase,
rung)` before any results were folded, the orchestrator resets the worktree to
  `tip_sha` — discarding **only** the interrupted phase's work (prior completed
  phases live below that tip and survive) — then re-spawns clean.
- **Cleared on a terminal write.** `complete` / `fail` clear it; a record need not,
  because every forward edge changes `(phase, rung)` (advance moves the phase,
  escalate bumps the rung), so a stale checkpoint can never match.
- **Scope.** `phase` is the spawn-phase subset (`tests | exec | verify`) — preflight
  and ship never spawn. A `verify` re-spawn's reset is a no-op (the panel reviewers
  run in their own isolated worktrees, so the shared worktree HEAD never moved).

(The `phase` literals duplicate the runner's spawn-phase set deliberately, so
`src/core/state` need not import the runner; a cross-check test keeps them equal.)

## `QuotaCheckpoint`

`{ resets_at_epoch?, binding_window?: "5h"|"7d" }` — the minimal state a resumable
run persists. Present _iff_ the run is `paused` or `suspended`; resume must clear
it before returning to `running`.

## `DocsStage`

`{ status: "done" | "failed", reason?, ended_at }` — the engine-owned documentation
phase marker ([Decision 37](../explanation/decisions.md#decision-37--documentation-is-an-engine-phase-before-finalize)).
Absent until the phase runs. `done` once scribe's output is committed onto the
`staging-<run-id>` branch (or a no-op pass); `failed` (with a `reason`) records the
one-attempt failure while the run sits `suspended`, resumable via `/factory:resume`.
There is no `skipped` value — when docs are not applicable (no `/docs` directory or
`package.json` `factory.docs.enabled: false`), `factory next-task` decides applicability
read-only and the marker simply stays absent.
</content>
