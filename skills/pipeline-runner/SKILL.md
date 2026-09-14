---
name: pipeline-runner
description: (internal) Drive Factory v2 PRD generation and sequential feature execution through persisted CLI actions.
auto-invoke: false
---

# Sequential feature runner

The CLI owns transitions, checks, repair budgets, delivery and recovery. The session
calls it, dispatches the named agents, and writes their output where the engine
reads it. One PRD has one feature branch and one PR. Never run two producer agents
for a repository. Keep driving until `terminal`, `park`, or the user interrupts:
an agent that finished but whose output was never written for the engine is the
stall this protocol exists to prevent.

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
  The moment an agent returns, write its result JSON verbatim to `staged[<role>]`
  from the envelope (one file per role; the file's existence is the submission).
  A markdown fence or prose around the object is tolerated; never edit the object.
  If a role's agent type is not offered, the installed plugin is stale: update it
  rather than substituting another agent.
  Never author, discard or change a finding or acceptance decision, and never
  merge roles into one file. Once every role's file is written, call
  `factory next-action --run <id> --driver <session>` (no `--results`); the
  engine merges and validates the staged files and journals accepted evidence.
- `wait`: if `reason` says an attempt is awaiting roles, write any finished
  agent's output to its staged path and call again; never dispatch it twice.
  If it says a staged file was rejected, that role finished wrong: run
  `factory resume --run <id> --recover` and the engine redispatches only it.
  Otherwise arm one timer sized to `retry_after_seconds` with
  `Bash(run_in_background)`, e.g. `until [ $SECONDS -ge <n> ]; do sleep 30; done`
  (not a bare foreground `sleep`), end the turn, and call `next-action` again
  when its completion notification arrives. Re-arm after every `wait`. Answer a
  user's status question briefly, then re-enter the loop; do not stop driving.
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
use `factory resume --run <id> --recover`. Recovery consumes a complete staged
result, keeps a partial review panel and re-issues only its missing roles on the
same attempt, or retires the attempt while retaining work. A new session may
consume an older attempt's staged files with its own driver identity; writing a
finished agent's output to its original attempt path is not relabeling. Never
rewrite a result to change its attempt or HEAD.

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
