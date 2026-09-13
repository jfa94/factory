---
name: pipeline-runner
description: (internal) Drive Factory v2 PRD generation and sequential feature execution through persisted CLI actions.
auto-invoke: false
---

# Sequential feature runner

The CLI owns transitions, checks, repair budgets, delivery and recovery. The session
calls it, dispatches the named agents, and submits their output. One PRD has one
feature branch and one PR. Never run two producer agents for a repository.

## Generate an executable spec

Before generation, run `factory scaffold` for the target repository and resolve
its reported local setup requirements. Commit the gate contract to the base branch
through the repository's authorized workflow. Provision remote protection only
with the user's authorization; creation requires stable strict protection.

Run `factory spec resolve --issue <n>` (optional `--repo owner/name` and
user-requested `--ignore-quota`). Generation snapshots the current PRD, base commit
and repository contracts. Do not import a task suite or reuse v1 artifacts.

Drive the returned envelopes:

- `generate` or `revise`: dispatch the named generator with the complete
  `spawn.context`. Save its GenerateResult JSON verbatim to `generated_path`,
  then call `factory spec gate --issue <n>`.
- `review`: dispatch a fresh spec reviewer with the complete context. Save its
  ReviewVerdict JSON to `verdict_path`, then call `factory spec store --issue <n>`.
- `stored`: proceed to creation.
- `pause`: report the reason and stop. There is no running feature to resume yet.
- `unspecifiable` or `spec-defect`: report the blockers and stop.
- Any unknown envelope or CLI failure: surface the error; do not invent a transition.

The engine owns the five-revision limit. Never rewrite malformed agent output to
make it pass; submit it so the engine can provide bounded revision feedback.
All criteria are visible. Tasks must have slice IDs, requirement IDs, exact paths
and explicit dependencies for shared files. Coherent tasks have no three-file cap.

## Create and advance

Run `factory run create --issue <n>`, forwarding user-requested `--no-ship`,
`--e2e` and `--ignore-quota`. Read `run_id` from the returned run object.
Creation refuses stale inputs and another active feature in the repository.
Version 1 runs cannot execute; their files remain available for diagnosis.

Choose one stable driver identity for this session (the actual session ID when
available). Call `factory next-action --run <id> --driver <session>`.

- `execute`: save the attempt identity before dispatch. Work only at
  `attempt.worktree`, on the supplied base and HEAD. Spawn exactly the roles
  in `attempt.roles`, each with the full engine prompt and its role instructions.
  **Do not request native worktree isolation:** the engine already owns the
  producer worktree and immutable review snapshot. Do not create task branches.
  Review the exact committed range with `git diff <attempt.base_sha>..<attempt.head_sha>`.
  Dispatch producers sequentially. Reviewers are fresh independent agents;
  never share one reviewer's reasoning with another before all reviews finish.
  Collect their evidence verbatim into one result, with one reviews entry per
  requested reviewer. The driver may assemble this envelope, but may not author,
  discard or change a finding or acceptance decision.
  Save the JSON outside protected engine state, then call
  `factory next-action --run <id> --driver <session> --results <file>`.
- `wait`: respect `retry_after_seconds`. If an attempt is already issued, wait
  for that agent; never dispatch it twice. Otherwise poll the CLI after the delay.
- `park`: stop dispatching and report the persisted reason. Explicit resume is
  required, even if quota recovers.
- `terminal`: report the exact status and delivery URL or no-change outcome.
  `ready-for-review` is a complete feature PR awaiting human review.
  `completed` requires a confirmed merge or verified no-change outcome.

Every execution result uses the identity and JSON schema in the engine prompt.
Those instructions govern v2 results even when a role's older standalone examples
show another schema. Never translate an absent result into a passing review.
`already-satisfied` is a claim requiring engine checks and independent evaluation.
A failed command, missing evidence, or unavailable environment cannot count as a pass.

## Stop and resume

Stop with `factory run stop --run <id>`. Preserve branches, commits, uncommitted
work, answers and result files. Do not reset, rebase away accepted work, force-push,
delete branches, change protection, or edit engine state.

Inspect `factory state --run <id> --ledger`. Resume with
`factory resume --run <id>`, supplying `--answer <text>` for a pending question.
Answers remain in the ledger and all future producer contexts.

If a dispatched agent was interrupted, first establish that it has stopped, then
use `factory resume --run <id> --recover`. This retires its lease while retaining
work. Start advancing with the current driver's identity. A previous attempt's
late output is stale; do not relabel it as a new attempt.

Cancel only when requested: `factory run cancel --run <id>` preserves artifacts.
Never infer cancellation from elapsed time or an unavailable dependency.

## Review boundaries

Task checks and a focused quality review precede acceptance. Complete slices and
the complete feature receive integrated checks and the broader review panel.
Independent confirmation decides whether cited findings require repair. A fresh
acceptance evaluator supplies evidence for every requested criterion. Producer
claims, commit ancestry and unrelated green tests are insufficient.

Repair budgets belong to the engine: three passes per task, slice, feature or
spec repair. Infrastructure waiting is not an implementation repair. Spec repair
must preserve the PRD, frozen contracts and accepted task prefix. Accepted work is
repaired forward.

GitHub writes remain subject to the user's authorization. Do not bypass a required
approval. A local terminal status never authorizes unrelated repository writes.
