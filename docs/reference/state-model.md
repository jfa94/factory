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
└── runs/
    ├── current                        # symlink → the active run
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

`<repo-key>` is a sanitized single path segment derived from `owner/name` (the
slash and any unsafe char folded to `-`; a pure-dot path-traversal segment is
rejected).

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

| Field                       | Type                       | Meaning                                             |
| --------------------------- | -------------------------- | --------------------------------------------------- |
| `schema_version`            | `1`                        | State-schema version (forward-migration marker).    |
| `run_id`                    | string                     | `run-YYYYMMDD-HHMMSS`.                              |
| `status`                    | RunStatus                  | See below.                                          |
| `driver`                    | `sequential \| balanced`   | The driver preset that produced this run.           |
| `spec`                      | SpecPointer                | Pointer to the durable spec (not an embedded spec). |
| `tasks`                     | record<task_id, TaskState> | Per-task state.                                     |
| `quota`                     | QuotaCheckpoint?           | Resume checkpoint; present _iff_ paused/suspended.  |
| `started_at` / `updated_at` | string                     | ISO-8601.                                           |
| `ended_at`                  | string \| null             | ISO-8601, null until terminal.                      |

### `RunStatus`

| Value       | Terminal? | Meaning                                                                                                |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `running`   | no        | Actively executing.                                                                                    |
| `paused`    | no        | Quota 5h-window breach; waiting out the curve in-session, self-heals.                                  |
| `suspended` | no        | Quota 7d-window breach; state persisted, process exited cleanly; resume continues from checkpoint.     |
| `completed` | yes       | Every task done, rollup CI green (success).                                                            |
| `partial`   | yes       | Retry ladder exhausted on ≥1 task; the done-set shipped, failures handed off loudly (quality failure). |
| `failed`    | yes       | Could not start / non-recoverable error before any partial delivery.                                   |

`paused`/`suspended` are **quota** states; `partial` is a **quality** outcome —
they must stay distinct.

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
| `started_at` / `ended_at` | string?                    | ISO-8601.                                                      |

### `TaskStatus`

| Value       | Terminal? | Meaning                                                                |
| ----------- | --------- | ---------------------------------------------------------------------- |
| `pending`   | no        | Not started, or blocked on an unsatisfied dependency.                  |
| `executing` | no        | A producer stage (test-writer / executor) is in flight.                |
| `reviewing` | no        | The verifier floor (gates + panel) is in flight.                       |
| `shipping`  | no        | Verified; PR open / merging into staging.                              |
| `done`      | yes       | Merged into staging (success).                                         |
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

## `QuotaCheckpoint`

`{ resets_at_epoch?, binding_window?: "5h"|"7d" }` — the minimal state a resumable
run persists. Present _iff_ the run is `paused` or `suspended`; resume must clear
it before returning to `running`.
</content>
