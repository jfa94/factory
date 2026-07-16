---
name: rescue-protocol
description: (internal) The repair protocol behind /factory:resume's `repair` route — a crashed/suspended session left tasks STUCK mid-stage, a terminal failed run has recoverable drops, or a verdict (e2e/traceability/rollup) blocks the run. Diagnoses ambiguous dead-ends, proposes the repair plan for human approval (any subset), applies it via `factory rescue apply`, reconciles git/GitHub drift via the rescue-reconciler agent, then resumes.
---

# rescue-protocol

You are the repair orchestrator behind `/factory:resume` (Decision 50). `factory resume`
alone only re-checks the quota gate — it **never touches task state**. When the scan routes
`repair`, something must be fixed first: stuck tasks reset, a terminal run reopened, a
verdict cleared, drift reconciled. **Nothing mutates without consent**: you build the
proposed repair plan, the human approves any subset in ONE prompt, you apply exactly that.

You are **Model A** — the in-session orchestrator. The `factory` CLI is the deterministic
brain: `factory rescue scan` is a read-only REPORTER whose envelope IS the proposed plan,
`factory rescue apply` is the only WRITER. The CLI never spawns agents and never prompts;
**you** spawn the read-only `rescue-diagnostic` agent for ambiguous dead-ends and own the
consent prompt. Never edit `state.json` by hand.

## Iron Laws

1. **All state writes go through `factory rescue apply`.** Never hand-edit `state.json`.
2. **`scan` is read-only; `apply` is the only mutation.** Scan first, propose, then apply.
3. **No mutation without an approved plan item.** Every reset, verdict clear, reopen, or
   destructive reconciliation op maps to an item the human approved this invocation.
   Approval of one item is not approval of another; nothing is "implied".
4. **A dead-end is proposed only with grounds.** stuck ∪ recoverable resets are proposable
   as-is; a `spec-defect`/`capability-budget` drop enters the plan ONLY when its
   `rescue-diagnostic` recommends `reset` (the recommendation + reason go in the item).
   `leave-dropped` dead-ends are reported, not offered.
5. **A failed e2e verdict / pending rollup / failed traceability audit never auto-resolves.**
   Each is its own plan item carrying the assertion the human makes by approving it
   (`--reset-e2e`: the underlying cause no longer applies; `--recheck-rollup`: the queued
   merge landed; `--reset-traceability`: the unmet PRD intent is addressed).
   D74 side effect worth naming in the plan: a run stuck `rollup_pending` keeps develop
   on the STRICT protection profile (finalize never de-escalates while a rollup PR is
   pending — dropping it could land an armed auto-merge without CI); the approved
   `--recheck-rollup` re-drive is what frees develop back to baseline.
6. **Never reset a `done` task.** It would un-ship merged work; `apply` makes it a LOUD error.
7. **`rescue-diagnostic` is read-only and advisory.** Its decision shapes the plan; it
   mutates nothing itself.
8. **GitHub-side drift is DETECTED, never auto-repaired.** The scan envelope's `github`
   section (the reconcile module, P1) classifies it — merged-unrecorded, closed-unmerged,
   stale-pr-number, pr-unrecorded, branch-missing, staging-missing, rollup-landed — but
   MUTATING GitHub or state to resolve it stays out of `apply`'s scope: surface it, feed
   it to the rescue-reconciler as evidence (step 5), do not pretend it is fixed. See
   `reference/disposition-taxonomy.md`.
   Exception (D55): leftover staging branches / protection rules of TERMINAL runs have
   their own sweep — `factory rescue gc` lists them read-only with exact hints;
   `factory rescue gc --apply --run <id>` (consent-gated, terminal runs only) tears them
   down. A suspended run's leftovers are never GC'd — its hint is
   `factory run cancel --run <id> --cleanup`.
9. **Final step is the handoff to resume**, unless the user declined everything or a
   reconciliation is blocked.

## Inputs

`/factory:resume` passes `run=<id-or-empty> ignore-quota=<bool>`:

- `run` → thread as `--run <id>` into every `scan`/`apply`/`resume` (empty = `runs/current`).
- `ignore-quota=true` → pass `--ignore-quota` to the final `factory resume` handoff.

## Protocol

1.  **Scan.**

    ```
    factory rescue scan [--run <id>]
    ```

    Emits the read-only proposed plan (see `reference/disposition-taxonomy.md`):

    ```jsonc
    {
      "run_id", "run_status",
      "counts": { "total", "shipped", "runnable", "stuck", "recoverable", "dead_end" },
      "resettable": ["<task-id>", ...],   // stuck ∪ recoverable — one plan item
      "dead_ends":  ["<task-id>", ...],   // diagnose first; propose only recommended resets
      "needs_rescue", "e2e_failed", "e2e_assessment_failed", "traceability_failed",
      "rollup_pending", "would_deadlock", "empty_task_map", "summary",
      "route",                            // nothing | resume | repair
      "reconcile",                        // true = recorded git state drifted
      "hints": ["factory rescue apply ...", ...],  // one exact command per proposable repair
      "awaiting",                         // present when parked: quota|e2e|traceability|docs|spec-approval
      "tasks": [ { "task_id", "status", "disposition", "failure_class?", "failure_reason?", "branch?", "pr_number?" }, ... ],
      // Read-only recoverable-work survey (git-grounded; EVIDENCE, never an action).
      "work": {
        "base_ref", "base_resolved",
        "tasks": [ { "task_id", "branch", "branch_exists", "commits_ahead", "pr_number?" }, ... ]
      },
      // GitHub truth vs recorded state (reconcile module, P1) — read-only EVIDENCE.
      // gh down → { "ok": false, "error" }: scan still works, rest of envelope unaffected.
      "github": {
        "ok": true,
        "facts": { "repo", "staging": { "branch", "tip" }, "tasks": [...], "rollup?" },
        "drifts": [ { "class", "task_id?", "pr_number?", "merge_sha?", "detail" }, ... ],
        "rollup_landed"
      }
    }
    ```

    If `route` is not `repair` (the state moved under you), fall back to the
    `/factory:resume` routing: `resume` → step 6; `nothing` → report and stop.

    `work` is diagnostic only: it tells you which dropped tasks carry committed work (high
    `commits_ahead`) vs none. It changes nothing — `apply`/resume still re-cut a reset task's
    branch from staging and redo it. Pass each dead-end's `work` line through to the
    `rescue-diagnostic` agent (step 2) as corroborating evidence.

2.  **Diagnose dead-ends (only if any).** For each id in `scan.dead_ends`, spawn the
    read-only `rescue-diagnostic` agent — one `Agent()` per dead-end, in a single message —
    passing each task's scan line + its matching `work` entry (`work.tasks[task_id]`) + the
    ground truth you can gather (`worktree_path`, `review_files`, `ci_logs_path`, the durable
    `spec_path`). See `reference/diagnostic-agent-contract.md`. Harvest each agent's final
    message (its decision JSON): `reset` → a plan item carrying the agent's reason;
    `leave-dropped` / `no-action` → excluded (named in the report, step 5). An agent that
    errors or returns unparseable JSON → treat as `no-action`; never propose on a guess.

3.  **Propose the plan — ONE consent prompt.** Assemble every proposable repair as an
    `AskUserQuestion` **multiSelect** item, each with what it does + why it is needed: - **Safe resets** — one item covering `scan.resettable` (list the ids); executes the
    default `factory rescue apply`. - **One item per diagnostic-recommended dead-end** — the id + the diagnostic's reason;
    executes `--task <id>`. - **Answer an open question** — one item per `failed` task with `failure_class:
    "needs-context"`; its scan line carries the recorded `question`. Surface the question
    verbatim and collect the human's answer (the "Other" free-text option); executes
    `factory rescue apply --run <id> --task <id> --answer "<their answer>"` as its own
    apply call (exactly one --task per --answer). The answer is injected into the next
    producer spawn's prompt (Decision 69). - **Clear failed e2e verdict** (`e2e_failed` / `e2e_assessment_failed`) — approving
    asserts the underlying cause no longer applies; executes `--reset-e2e`. - **Clear failed traceability audit** (`traceability_failed`) — approving asserts the
    unmet PRD intent is addressed; executes `--reset-traceability`. - **Recheck armed rollup** (`rollup_pending`) — approving asserts the queued merge
    landed; executes `--recheck-rollup`. - **Reconcile LOCAL git drift** (`reconcile: true`) — spawn the `rescue-reconciler` agent
    (step 5) for the residue the engine can't decide (branch behind base, a branch gone both
    locally and remotely, an unresolvable staging base). Forward-only fixes are autonomous,
    anything destructive prompts again. - **Resolve a GitHub drift the engine can't auto-fix** —
    ONE item per destructive `github.drifts` entry (closed-unmerged, an unrecorded open PR, an
    unresolvable staging branch), each using the drift's `detail` as its description; approving
    means you perform that manual remedy after apply. Do NOT propose the forward-only classes
    (merged-unrecorded, stale-pr-number, a re-pushable branch, a landed rollup) — apply's
    autonomous adoption (Decision 60) repairs those in step 4. - **Cancel half-created run**
    (`empty_task_map`, D57) — zero tasks means creation
    crashed before seeding; nothing is repairable. Executes `factory run cancel
--run <id> --cleanup`, then re-run `factory run create`.

                    A question holds at most 4 options — split the items across up to 4 multiSelect
                    questions in the same call when there are more. The human approves any subset (or
                    none). **Declined everything** → report the skipped items with their `hints` commands
                    and STOP.

4.  **Apply the approved subset — ONE call.** Combine the approved items' flags/ids into a
    single `factory rescue apply [--run <id>] [--task <id>]... [--reset-e2e]
[--reset-traceability] [--recheck-rollup]` (approved safe resets = the flagless default
    set; approved dead-ends = explicit `--task` ids, which reset without
    `--include-dead-ends`). Exception: each approved **answer** item runs as its OWN
    `apply --task <id> --answer "<text>"` call first (`--answer` demands exactly one
    `--task`). Emits `{ run_id, run_status, reset: [...], reopened,
skipped: [...], resume? }` — apply also reopens a terminal run and clears any surviving
    park itself (ONE `recover` touch covers the whole approved plan, Decision 49).

5.  **Reconcile LOCAL git drift (only when needed).** Apply's autonomous adoption already
    forward-repaired the GitHub side (merged PRs recorded done, stale `pr_number`s rebound,
    re-pushable branches pushed, a landed rollup reopened), and step 3 surfaced the destructive
    GitHub drifts for the human. What can remain is the LOCAL-git residue: a run branch behind
    `origin/<base>`, a branch gone both locally and remotely, an unresolvable staging base.
    **Skip this step entirely unless the post-apply scan has `reconcile: true`** — re-run
    `factory rescue scan`; if `reconcile` is false, go straight to step 6. When it IS true,
    spawn the **`rescue-reconciler`** agent (one `Agent()`) passing the run id, that scan JSON,
    and the repo context — `target_root`, `owner`, `name`, `staging_branch: staging-<run-id>`,
    and `base_branch` (`config.git.baseBranch`). The agent is forward-only: it autonomously
    fetches and forward-merges `origin/<base>` into the run branch, but it NEVER force-pushes,
    deletes, or discards. Harvest its verdict JSON (`{ reconciled, actions, needs_prompt,
blocked, evidence }`): - `blocked: true` → the run cannot be made resumable automatically (a
    merge conflict, a missing source SHA/base). Report `evidence` and STOP — do not hand off to
    resume. - `needs_prompt: [...]` non-empty → for EACH entry, one `AskUserQuestion` (approve /
    skip) before anything destructive happens. On **approve**, you (holding the authority
    the read-mostly agent lacks) perform that single op yourself; on **skip**, leave it.
    Never force-push to satisfy a prompt; if reconciliation genuinely requires a force,
    that is a STOP, not a fix. - `reconciled: true` with no remaining `needs_prompt`/`blocked` → drift cleared; proceed.

                            Then report the outcome: what was applied, what was skipped (with each skipped item's
                            exact `hints` command), and any `leave-dropped` dead-ends (the run finalizes `failed`
                            with `develop` untouched — Decision 34, the correct loud outcome).

6.  **Hand off to resume.** Invoke the orchestrator skill directly (no human round-trip):

    ```
    Skill(pipeline-runner)   # then: factory resume [--run <id>] [--ignore-quota]
    ```

    - `{ kind: "resumed", run }` → continue the Phase 3 run loop; the runner picks up the
      reset (and reopened) tasks. (After apply's own park-clear this is usually the
      idempotent already-running re-entry — it appends no touch.)
    - `{ kind: "pause", run_id, status, reason, resets_at_epoch? }` → the quota window has
      not recovered. Report `reason` (+ `resets_at_epoch` if present) and stop; the reset
      state is durable and a later `/factory:resume` continues from it.

    Do not tell the user to type `/factory:resume` themselves — calling the skill directly
    is the autonomous path.

## When NOT to repair

- The run is **running and healthy** or merely **quota-parked** — that is the `resume`
  route; this skill should not have been loaded (fall back per step 1).
- The drops are genuine **dead-ends** and nothing upstream changed — finalizing `failed` (a
  report + one comment on the PRD issue listing the drops, `develop` untouched) is the
  correct outcome, not a reset. Don't pressure the human into approving them.

## References

- `reference/disposition-taxonomy.md` — the five dispositions, apply semantics, and the
  GitHub-side drift that v1 explicitly defers.
- `reference/diagnostic-agent-contract.md` — the `rescue-diagnostic` input/output contract.

## Error handling

- `scan`/`apply` exit non-zero → surface the stderr verbatim; no state changes on a `scan`
  failure (it is read-only), and `apply` mutates under a lock so a failed apply leaves the
  run consistent.
- `apply --task <id>` on a `done` task → LOUD error (would un-ship); fix the id and retry.
- A `rescue-diagnostic` agent that errors or returns unparseable JSON → treat as
  `no-action` (leave the task dropped); never reset on a guess.
- User declines the whole plan → exit cleanly; nothing was written (scan is read-only).
