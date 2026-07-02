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
untrusted input with `parseRunState` (it layers the run-level cross-field check
`refineRunCrossFields`), never `RunStateSchema.parse` directly. The cross-field
check enforces that each entry in the `tasks` map is keyed by its own `task_id`
(a key/`task_id` mismatch is a loud parse error), so DAG traversal and keyed
lookups never read a misfiled row.

| Field                       | Type                         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema_version`            | `2`                          | State-schema version (forward-migration marker). `StateManager.guardedParse` rejects any value other than `2` with a clear `UsageError` ("start a fresh run") rather than a raw `ZodError`; absent or `2` parses normally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `run_id`                    | string                       | `run-YYYYMMDD-HHMMSS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `status`                    | RunStatus                    | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `execution_mode`            | `sequential \| balanced`     | The task-scheduling preset (`ExecutionModeEnum`, default `sequential`) the orchestrator reads when choosing how many tasks to advance at once. NOT the runner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `mode`                      | `session \| workflow`        | Execution mode (default `session`). Persisted at create; selects which runner steps the seam and gates quota pacing (workflow = no pacing).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ship_mode`                 | `no-merge \| live`           | Ship mode (default `live` — auto-merge; `--no-ship` opts into `no-merge`). Persisted at create so the workflow runner / `resume` / `finalize` read it without re-passing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `owner_session`             | string?                      | Owning Claude Code session id. Scopes the Stop / SubagentStop gates (resolved via `findActiveByOwner`). **Required for session-mode runs** (an ownerless session-mode `run create` is rejected); only workflow-mode runs may persist it absent. An absent owner means no run is attributed to a stopping session, so the gate passes through (allow).                                                                                                                                                                                                                                                                                                                                                        |
| `staging_branch`            | string?                      | The run's integration branch, **pinned once at create** (`staging-<run-id>`). Identity/provenance, not a derived verdict — read everywhere via `resolveStagingBranch(run_id, staging_branch)` ([Decision 33](../explanation/decisions.md#decision-33-per-run-staging-branch-replaces-the-single-shared-staging-branch)). Legacy runs without it fall back to the recomputed name.                                                                                                                                                                                                                                                                                                                            |
| `spec`                      | SpecPointer                  | Pointer to the durable spec (not an embedded spec).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tasks`                     | record<task_id, TaskState>   | Per-task state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ignore_quota`              | boolean                      | When `true`, the quota gate is skipped unconditionally for this run — both orchestrators + runners read it from state (no per-call threading), mirroring the `mode==="workflow"` skip. Set at create from `--ignore-quota`, or toggled true by `factory resume --ignore-quota`. Default `false`; a legacy run without the field reads as `false`.                                                                                                                                                                                                                                                                                                                                                            |
| `quota`                     | QuotaCheckpoint?             | Resume checkpoint; present _iff_ paused/suspended.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docs`                      | DocsPhase?                   | Documentation-phase marker; absent until the engine docs phase runs ([Decision 37](../explanation/decisions.md#decision-37--documentation-is-an-engine-phase-before-finalize)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `e2e`                       | boolean (default false)      | Whether this run opted into the e2e phase (the `--e2e` flag). Set once at create, immutable across resume. Default `false`: a run without the flag never schedules the e2e stage ([Decision 39](../explanation/decisions.md#decision-39--e2e-is-a-run-level-engine-phase-criticality-is-persistence-not-a-tag)).                                                                                                                                                                                                                                                                                                                                                                                             |
| `e2e_phase`                 | E2ePhase?                    | E2E-phase marker + author manifest; absent until the e2e phase first runs. See [`E2ePhase`](#e2ephase).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `rollup`                    | `{number, merged, reason?}`? | The `completed` run's staging→develop rollup outcome, persisted at finalize **only when it did not land** (`merged:false` — e.g. the "auto-armed" branch-policy fallback, D3). Absent on a merged rollup (nothing to recover) or a `failed` run (no rollup attempted). Lets `rescue scan` flag an armed-but-not-landed rollup (`rollup_pending`) without a live GitHub call; `rescue apply --recheck-rollup` reopens the run so a re-drive re-enters `finalizeRun`, whose `rollup()` resume-guard picks up the now-merged PR and completes the PRD-close + branch-GC. Cleared (set absent) by a resumed finalize once the PR is merged. Only `finalizeRun` mutates this pointer — `rescue apply` never does. |
| `paused_minutes`            | number (default 0)           | Cumulative minutes the run spent idle between suspend/pause and resume/rescue-reopen, accumulated on each resume or rescue-reopen. The runtime circuit-breaker deducts it from wall-time so a long-paused run does not falsely trip. Absent on legacy runs → `0`.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `started_at` / `updated_at` | string                       | ISO-8601.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ended_at`                  | string \| null               | ISO-8601, null until terminal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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
| `phase`                   | TaskPhase?                    | The `next-action` orchestrator's resume cursor (see below).                                                                                                                                                                                                                                                                                                                                                                                                              |
| `merge_resyncs`           | int ≥0 (default 0)            | Ship live-merge re-sync count (see below).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `spawn_in_flight`         | object?                       | Spawn-in-flight checkpoint for idempotent re-spawn (see below).                                                                                                                                                                                                                                                                                                                                                                                                          |
| `e2e_feedback`            | string?                       | Feedback carried from a failing e2e journey into this task's NEXT implementation pass (the e2e reopen loop, [Decision 39](../explanation/decisions.md#decision-39--e2e-is-a-run-level-engine-phase-criticality-is-persistence-not-a-tag)). Set by the e2e coroutine when it reopens the task (via `resetTaskRow`); injected into the producer's prior-failure context. **Transient — not a failure field; allowed on any status.**                                       |
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

### `phase` — the `next-action` orchestrator's resume cursor

`"preflight" | "tests" | "exec" | "verify" | "ship"` (optional). The precise
machine cursor for `factory next-action`: which phase the task is at, or resuming at.
The `next-action` orchestrator reads it to resume after a crash; it is written by `markInFlight`.

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
merge and re-routed back through `exec` to re-sync. The `next-action` orchestrator enforces the cap
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
rung)` before any results were recorded, the orchestrator resets the worktree to
  `tip_sha` — discarding **only** the interrupted phase's work (prior completed
  phases live below that tip and survive) — then re-spawns clean.
- **Cleared on a terminal write.** `complete` / `fail` clear it; a record need not,
  because every forward edge changes `(phase, rung)` (advance moves the phase,
  escalate bumps the rung), so a stale checkpoint can never match.
- **Scope.** `phase` is the spawn-phase subset (`tests | exec | verify`) — preflight
  and ship never spawn. A `verify` re-spawn's reset is a no-op (the panel reviewers
  run in their own isolated worktrees, so the shared worktree HEAD never moved).

(The `phase` literals duplicate the orchestrator's spawn-phase set deliberately, so
`src/core/state` need not import the orchestrator; a cross-check test keeps them equal.)

## `QuotaCheckpoint`

`{ resets_at_epoch?, binding_window?: "5h"|"7d" }` — the minimal state a resumable
run persists. Present _iff_ the run is `paused` or `suspended`; resume must clear
it before returning to `running`.

## `DocsPhase`

`{ status: "done" | "failed", reason?, attempts?, ended_at }` — the engine-owned documentation
phase marker ([Decision 37](../explanation/decisions.md#decision-37--documentation-is-an-engine-phase-before-finalize)).
Absent until the phase runs. `done` once scribe's output is committed onto the
`staging-<run-id>` branch (or a no-op pass); `failed` (with a `reason`) records a
failed attempt. `attempts` is the cumulative 1-indexed attempt count (absent on legacy
records → treat as 1). While `attempts < MAX_DOCS_ATTEMPTS` (2) the run sits `suspended`,
resumable via `/factory:resume`; once the cap is hit docs become best-effort and the run
finalizes `completed` without a docs commit.
There is no `skipped` value — when docs are not applicable (no `/docs` directory or
`package.json` `factory.docs.enabled: false`), `factory next-task` decides applicability
read-only and the marker simply stays absent.

## `E2ePhase`

`{ status?: "done" | "failed", reason?, advisory?, attempts?, manifest, reopen_counts, ended_at? }`
— the engine-owned e2e-phase marker + author manifest ([Decision 39](../explanation/decisions.md#decision-39--e2e-is-a-run-level-engine-phase-criticality-is-persistence-not-a-tag)),
present only on an `--e2e` run and absent until the phase first runs.

Unlike `DocsPhase` (written once, never re-entered), this marker is **re-fired** on every
reopen: `status` is cleared back to absent when a failing journey reopens a task, so the
phase runs again once the reopened task settles. Two fields **persist** across the clear:

- `manifest` — the author's spec→task rows (`{ task_ids, spec_path, kind: "critical" | "throwaway" }`),
  fixed at authoring time and reused on every later pass (the author is not re-invoked;
  throwaway specs are re-run, not re-authored). This is the only join from a failing spec
  back to its task.
- `reopen_counts` — per-`task_id` cumulative reopen count, bounding each task by
  `e2e.reopenCap` across the whole run, not just one pass.

`status` semantics: absent = not yet run this pass (or cleared for a reopen re-fire);
`done` = every critical spec present and green (the run proceeds to docs); `failed` (with
`reason`) = the run fails. A critical spec counts as proven only when it appears in the
results as `passed` or `flaky` — an **absent, `failed`, or `skipped`** critical spec is a
non-pass. `failed` reasons include: a residual critical miss past the reopen cadence, an
unmappable critical failure (no manifest entry names the spec), a **tooling failure**
(nonzero Playwright exit / reporter `errors[]` with no spec marked failed), an author
manifest that references an **unknown `task_id`** (validated against `run.tasks` at ingest)
or an unsafe/absolute `spec_path`, a **`critical` `spec_path` that lands outside `testDir`**,
an author branch that touches **any** path outside `testDir` (the single stray-file rule —
no per-file manifest allowlist), a rejected fail-first proof, an exhausted `reopenCap`, or a
non-`DONE` author status. `advisory` is the `done`-side counterpart of
`reason` — a non-gating note (e.g. residual throwaway red) enforced as **never present on
`failed`** (mirroring the `reason`-set-IFF-`failed` invariant). `attempts` is the
cumulative 1-indexed pass count. A reopen never touches `run.status`, which stays
`running` until `finalize`.

A `failed` verdict is **repairable, not permanent**: `factory rescue apply --reset-e2e`
clears it via the shared `reopenE2ePhase` helper. The clear is **manifest-aware**:

- A phase that failed **after** authoring (non-empty `manifest`) has
  `status`/`reason`/`advisory`/`ended_at` dropped while `manifest`, `reopen_counts`, and
  `attempts` are **preserved** — the phase re-enters and re-derives on the next pass without
  re-invoking the author.
- A phase that failed **before** a manifest was ever authored (empty `manifest` — every
  pre-authoring `markFailed`: author crash, non-`DONE` status, unsafe `spec_path`) is dropped
  **entirely** (`e2e_phase` set to absent), so `runE2eEmit`'s `run.e2e_phase === undefined`
  gate re-fires and the author actually re-spawns. Preserving an empty-manifest phase would
  otherwise let `runSuiteAndDecide` `markDone` a false "done" with zero e2e coverage.

This is never automatic —
`rescue scan` surfaces it as `e2e_failed: true` (folded into `needs_rescue` even when every
task is `done`), and `apply` clears it only on the explicit `--reset-e2e` flag. Plain
`resume` does not clear it; it only re-checks the quota gate.
