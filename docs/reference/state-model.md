# V2 state model

Engine state lives under the plugin data directory (`$CLAUDE_PLUGIN_DATA`), outside
the target repository. Schemas are in `src/feature/schema.ts`; persistence is in
`src/feature/store.ts`.

## Layout

| Path                                                       | Contents                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `runs-v2/<run-id>/state.json`                              | The run (schema below). Written atomically; schema-validated on every write. |
| `runs-v2/<run-id>/ledger.md`                               | Readable projection: status, in-flight attempt, checkpoints, answers, audit. |
| `runs-v2/<run-id>/results/<attempt-id>.json`               | Journal of accepted, merged attempt results.                                 |
| `staged-v2/<run-id>/<attempt-id>/<role>.brief.md`          | The brief the role's agent reads.                                            |
| `staged-v2/<run-id>/<attempt-id>/<role>.json`              | The agent's raw reply, written verbatim by the runner.                       |
| `staged-v2/<run-id>/<attempt-id>/<role>.rejected-<n>.json` | A rejected reply, kept as evidence.                                          |
| `locks-v2/<digest(repo)>`                                  | Per-repository lock serializing all transitions.                             |
| `v2/specs/<repo-key>/<spec-id>/`                           | Durable stored specs (`feature.json`).                                       |

`runs-v2/`, `locks-v2/` and the spec store are engine-owned and write-protected
from agents (see [hooks.md](./hooks.md)). Staged files sit outside `runs-v2/` so
the driver session can write them. A run whose `state.json` is missing, invalid or
of another version cannot be read; `state --list` skips it with a warning.

## Run fields

| Field                                             | Meaning                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `version`, `run_id`, `repo`, `root`               | Schema version 2, run id, `owner/name`, repository root.                                  |
| `branch`, `worktree`                              | Feature branch `factory/<issue>-<id>` and its worktree `.claude/worktrees/feature-<id>`.  |
| `base_branch`, `remote`                           | Resolved base branch and remote (`origin`).                                               |
| `ship_mode`                                       | `live`, `no-ship` or `local`.                                                             |
| `debug`, `e2e`, `ignore_quota`                    | Creation flags.                                                                           |
| `owner_session`                                   | Claude Code session currently driving the run.                                            |
| `spec`, `spec_digest`                             | Frozen spec snapshot and its digest; a mismatch makes the run unreadable.                 |
| `status`, `stop_reason`, `wait_since`             | Lifecycle (below).                                                                        |
| `stage`, `task_index`                             | Current stage and task.                                                                   |
| `accepted_sha`, `task_base_sha`, `slice_base_sha` | Last accepted HEAD and the bases of the current task and slice.                           |
| `verified_feature`                                | HEAD and spec digest recorded by final acceptance; delivery must match both.              |
| `attempts`                                        | Repair passes spent per scope (`task:<id>`, `slice:<id>`, `feature`, `spec`).             |
| `in_flight`                                       | The outstanding attempt (below).                                                          |
| `checkpoints`                                     | Accepted tasks with their HEAD.                                                           |
| `question`, `answers`                             | Pending spec-loop question and recorded answers.                                          |
| `feedback`                                        | Repair feedback carried into the next producer brief.                                     |
| `rejections`                                      | Per-role rejection reasons since the last accepted result.                                |
| `transient_failures`                              | Consecutive transient infrastructure failures.                                            |
| `final_pass`                                      | The scheduled repair is its scope's last pass; its producer runs on Opus.                 |
| `rereview`                                        | `{boundary, base, claims}` for a repair's scoped re-review.                               |
| `claims`, `confirmed_claims`, `after_confirm`     | Review claims awaiting confirmation, confirmed blockers, and the boundary they return to. |
| `candidate_satisfied`                             | The current task was reported already satisfied and is being verified.                    |
| `repaired_spec`                                   | A spec revision awaiting review.                                                          |
| `delivery`                                        | `pr_number`, `head_sha`, `url`, `outcome` (`merged`, `no-change`, `review`).              |
| `audit`                                           | Append-only events: `at`, `event`, `stage`, `head_sha`, `details`.                        |

## Stages

`prepare`, `tests`, `implement`, `task-check`, `task-review`, `slice-check`,
`slice-review`, `docs`, `e2e-author`, `feature-check`, `feature-review`,
`acceptance`, `confirm`, `spec-repair`, `spec-review`, `deliver`.

## Statuses and stop reasons

| Status             | Terminal | Meaning                                                                               |
| ------------------ | -------- | ------------------------------------------------------------------------------------- |
| `running`          | no       | Advancing.                                                                            |
| `waiting`          | no       | Waiting on quota (never in `deliver`) or a transient failure; `next-action` rechecks. |
| `awaiting-merge`   | no       | PR open; waiting for required checks and merge.                                       |
| `parked`           | no       | Stopped until `factory resume`.                                                       |
| `ready-for-review` | yes      | No-ship, debug or `main`-based live delivery finished.                                |
| `completed`        | yes      | Merge observed, or verified no-change.                                                |
| `cancelled`        | yes      | Cancelled; branch and work preserved.                                                 |

`stop_reason.kind` is one of `operator`, `quota`, `ci`, `environment`, `producer`,
`spec`, `context`, `authorization`.

## Attempts

An attempt (`in_flight`) records `id`, `driver`, `stage`, `base_sha`, `head_sha`,
`spec_digest`, `worktree`, `roles`, `issued_at`, and optional `redispatch` and
`models` (a per-role Agent model override, set on a final repair pass).
Producer stages use the feature worktree. Review stages use a detached snapshot at
`.claude/worktrees/review-<run>-<attempt>`, removed after the attempt is accepted
or retired; a failed removal is audited and does not block the run.

While any role's staged file is missing, `next-action` returns `wait` and never
dispatches the attempt twice. Any driver may consume a finished attempt.

## Agent results

What one agent writes (`AgentResultSchema`):

| Field           | Type                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| `status`        | `done`, `already-satisfied`, `needs-context`, `spec-defect`, `blocked` |
| `message`       | string, optional                                                       |
| `claims`        | reviewers: `{severity, file, line, quote, claim}[]`                    |
| `confirmations` | finding-verifier: `{id, confirmed, evidence}[]`                        |
| `acceptance`    | acceptance-evaluator: `{id, met, evidence}[]`                          |
| `repaired_spec` | spec-generator at `spec-repair`                                        |

Results carry no identity fields; unknown keys are stripped. The role comes from
the staged path, and the store assigns claim ids `<role>.<n>`. A Markdown fence or
prose around the JSON object is tolerated on read.

### Result validation

A staged file is rejected when it is unparseable or schema-invalid, or when the
engine rejects its content (missing `claims`, an invalid citation, incomplete
confirmations or acceptance rows, uncommitted work, an already-satisfied report on
a changed checkpoint). On rejection the file is renamed to
`<role>.rejected-<n>.json`, the reason is appended to `rejections[role]`, and the
role is re-issued on the same attempt with the reason. The third rejection of a
role parks the run as `producer`. Rejections do not spend repair passes and are
cleared when a result is accepted or the run is resumed.

A `blocked` status outside `spec-repair` is treated as a rejection with the reason
`agent reported blocked: <message>`; when it exhausts the role's re-issues the run
parks as `environment` instead of `producer`.

### Status routing

When a review panel merges, the first non-`done` role's status and message become
the attempt's result (`halted_role` names that role) and the other reviewers'
claims are dropped.

| Status          | Stage                                                    | Effect                                                                              |
| --------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `needs-context` | any except `spec-repair`/`spec-review`                   | Spec repair with feedback `<role> needs context: <question>`; spends a `spec` pass. |
| `needs-context` | `spec-repair`, `spec-review`, or `spec` passes all spent | Sets `question`; parks as `context`.                                                |
| `blocked`       | any except `spec-repair`                                 | Re-issued as a rejection (above).                                                   |
| `blocked`       | `spec-repair`                                            | Sets `question` to the message; parks as `spec`.                                    |
| `spec-defect`   | any                                                      | Spec repair.                                                                        |

While `question` is set, `resume` requires `--answer`; the answer is appended to
`answers` and the question is cleared.

If a review snapshot was modified, the attempt is retired and a fresh one with a
new snapshot is issued.

## Repairs and transient failures

Each repair scope has three passes (`REPAIR_PASSES`); spec repair is bounded the
same way and spec generation by `spec.maxRegenIterations`. After a confirmed
review finding, `rereview` limits the next review at that boundary to
`base..HEAD` plus the prior claims; repeated repairs keep the first base.

Scheduling a scope's third pass sets `final_pass`; the producer attempt issued for
it carries `models: {<producer role>: "opus"}` and audits `model escalated`. The
flag clears when that producer's result is recorded.

An accepted spec revision resumes at the first unaccepted task with `claims`,
`confirmed_claims`, `rereview` and `candidate_satisfied` cleared. When the current
task had not been accepted, `task_base_sha` returns to the last accepted
checkpoint (`accepted_sha`), so commits made before the repair are judged with the
restarted task instead of forming its baseline.

Transient failures (git fetch and push, `gh` PR and check calls, worktree
provisioning, and flaky tests) set `status: waiting` with an `environment` stop reason and return a
wait of `60 * 2^(n-1)` seconds for the nth consecutive failure (60, 120, 240, 480;
about 15 minutes in total). The fifth consecutive failure parks the run. A clean call resets
the count.

A flaky test is a native Vitest test-gate failure, with executed tests, on an
expected-green tree (any check stage except `tests`, or the `tests` baseline while
HEAD equals `task_base_sha`) whose failing files (Vitest `FAIL  <file>` rows) pass
when rerun alone. The wait reason is
`flaky tests: <files> failed, then passed on rerun`, and the whole check is retried.
A failure that repeats on rerun spends a repair pass. Contract-command test gates
are not rerun.

## Recovery

`resume --recover`, after the previous agent stopped, either consumes a complete
staged result, re-issues only the missing roles of a partial panel on the same
attempt (`redispatch`), or retires the attempt. An invalid durable result is
retired with its reason added to `feedback`. Git work is never reset.

See [architecture](../architecture/overview.md) and [CLI](cli.md). The v1 state
model is preserved at the git tag `archive/v1-engine`
(`git show archive/v1-engine:docs/reference/state-model.md`).
