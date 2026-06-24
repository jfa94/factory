---
name: rescue-protocol
description: (internal) Recover a factory pipeline run that `factory resume` cannot untangle — a crashed/suspended session left tasks STUCK mid-stage, or a terminal failed run has recoverable drops to retry. Resets the resettable tasks via `factory rescue apply`, reopens a terminal run, reconciles git/GitHub drift via the rescue-reconciler agent, then hands off to resume.
---

# rescue-protocol

You are the rescue orchestrator. `factory resume` only re-checks the quota gate — it
**never touches task state**. When a crashed or suspended session left tasks stuck mid-stage
(so a re-drive would deadlock), or a terminal `failed` run has `blocked-environmental` drops
worth retrying, resume alone cannot recover it. Rescue is that missing seam: it resets the
resettable tasks, reopens a terminal run, reconciles git/GitHub drift, then hands back to
resume + the run loop.

You are **Model A** — the in-session orchestrator. The `factory` CLI is the deterministic
brain: `factory rescue scan` is a read-only REPORTER, `factory rescue apply` is the only
WRITER. The CLI never spawns agents; **you** spawn the read-only `rescue-diagnostic` agent for
ambiguous dead-ends. Never edit `state.json` by hand.

## Iron Laws

1. **All state writes go through `factory rescue apply`.** Never hand-edit `state.json`.
2. **`scan` is read-only; `apply` is the only mutation.** Scan first, reason, then apply.
3. **Default never repeats a dead end.** A default `apply` resets only stuck ∪ recoverable
   (`blocked-environmental`) tasks. A `spec-defect`/`capability-budget` drop is reset ONLY on
   an explicit assertion the root cause is fixed (`--include-dead-ends`, or `--task <id>`).
4. **Never reset a `done` task.** It would un-ship merged work; `apply` makes it a LOUD error.
5. **`rescue-diagnostic` is read-only and advisory.** Its decision drives whether you issue a
   `--task` reset; it mutates nothing itself.
6. **v1 reconciles RUN STATE only.** GitHub-side drift (merged-not-recorded PR, orphan
   branch/worktree, merge conflict, duplicate/closed-unmerged PR) is **out of scope** — surface
   it to the user, do not pretend it is fixed. See `reference/disposition-taxonomy.md`.
7. **Final step is the handoff to resume**, unless the user cancels or nothing was reset.

## Inputs

`/factory:rescue` passes `run=<id-or-empty> tasks=<csv-or-empty> include-dead-ends=<bool>
dry-run=<bool>`:

- `run` → thread as `--run <id>` into every `scan`/`apply` (empty = default to `runs/current`).
- `dry-run=true` → run steps 1–3 only: scan + report, then **stop**. No `apply`, no resume.
- `tasks` (csv, non-empty) → skip the default/diagnostic path; reset exactly those ids with
  `--task <id>` (repeated). A named dead-end is reset without `--include-dead-ends`.
- `include-dead-ends=true` → in step 5, reset all dead-ends (`--include-dead-ends`) instead of
  diagnosing per task (the human has asserted the upstream root cause is fixed).

## Protocol

1. **Resolve the target run.** Use `--run <id>` if given; otherwise the active run
   (`runs/current`). If neither resolves, stop with `no run to rescue`. (Both `scan` and
   `apply` default to `runs/current` themselves — pass `--run` only to override.)

2. **Scan.**

   ```
   factory rescue scan [--run <id>]
   ```

   Emits the read-only `RescueScan` (see `reference/disposition-taxonomy.md`):

   ```jsonc
   {
     "run_id", "run_status",
     "counts": { "total", "shipped", "runnable", "stuck", "recoverable", "dead_end" },
     "resettable": ["<task-id>", ...],   // stuck ∪ recoverable — default apply resets these
     "dead_ends":  ["<task-id>", ...],   // reset only on explicit assertion
     "needs_rescue", "would_deadlock", "summary",
     "tasks": [ { "task_id", "status", "disposition", "failure_class?", "failure_reason?", "branch?", "pr_number?" }, ... ],
     // Read-only recoverable-work survey (git-grounded; EVIDENCE, never an action). One
     // entry per non-shipped branched task, measured against origin/staging-<run-id>.
     "work": {
       "base_ref", "base_resolved",
       "tasks": [ { "task_id", "branch", "branch_exists", "commits_ahead", "pr_number?" }, ... ]
     }
   }
   ```

   `work` is diagnostic only: it tells you which dropped tasks carry committed work (high
   `commits_ahead`) vs none. It changes nothing — `apply`/resume still re-cut a reset task's
   branch from staging and redo it. Pass each dead-end's `work` line through to the
   `rescue-diagnostic` agent (step 5) as corroborating evidence.

3. **Short-circuit if clean.** If `needs_rescue` is `false` AND `would_deadlock` is `false`,
   there is nothing for rescue to reset. Skip to step 7 (resume) if the run is non-terminal;
   otherwise report `summary` (it may note dead-ends that need a fix + `--include-dead-ends`)
   and stop. **If `dry-run=true`, report the scan and stop here regardless** — never apply.

   **If `tasks` was given (non-empty):** skip the default + diagnostic paths entirely — apply
   exactly those ids and go to step 7:

   ```
   factory rescue apply [--run <id>] --task <id> [--task <id> ...]
   ```

4. **Apply the default (safe) set.** Resets stuck (crashed in-flight) + recoverable
   (`blocked-environmental`) tasks, and reopens a terminal run that had work to reset:

   ```
   factory rescue apply [--run <id>]
   ```

   Emits `{ run_id, run_status, reset: [...], reopened, skipped: [...] }`. `run_status` is
   `running` when a terminal run was reopened. This is safe to auto-apply — it never resets a
   dead-end and never touches `done` work.

5. **Decide on dead-ends (only if any).** For each id in `scan.dead_ends`, decide whether the
   root cause has cleared. Two paths:
   - **Diagnostic-gated (autonomous).** Spawn the read-only `rescue-diagnostic` agent — one
     `Agent()` per dead-end, in a single message — passing each task's scan line + its matching
     `work` entry (`work.tasks[task_id]`) + the ground truth you can gather (`worktree_path`,
     `review_files`, `ci_logs_path`, the durable `spec_path`). See
     `reference/diagnostic-agent-contract.md`. Harvest each agent's final
     message (its decision JSON). For every `decision: "reset"`, reset that one:

     ```
     factory rescue apply [--run <id>] --task <task-id> [--task <task-id> ...]
     ```

     (Naming a task IS the assertion the cause is fixed, so `--task` resets a dead-end without
     `--include-dead-ends`.) `leave-dropped` / `no-action` → leave it; the run finalizes
     `failed` with `develop` untouched (Decision 34 — develop receives only whole PRDs), which
     is the correct loud outcome.

   - **Human-asserted.** If a human has confirmed the upstream root cause is fixed for the
     whole set (e.g. the spec was amended, a stronger model is now available), reset them all:

     ```
     factory rescue apply [--run <id>] --include-dead-ends
     ```

     When run interactively and dead-ends exist, confirm with one `AskUserQuestion`
     (`reset-all-dead-ends` / `diagnose-each` / `leave-dropped`) before resetting — resetting a
     determined failure burns a full pipeline cycle.

6. **Reconcile git/GitHub drift.** Run state is now repaired, but the remote may still
   disagree with it (`rescue scan`/`apply` touch RUN STATE only). Re-run `factory rescue scan`
   for the fresh post-apply picture, then spawn the **`rescue-reconciler`** agent (one
   `Agent()`) passing the run id, that scan JSON, and the repo context — `target_root`,
   `owner`, `name`, `staging_branch: staging-<run-id>`, and `base_branch` (`config.git.baseBranch`).
   The agent is forward-only: it autonomously fetches, forward-merges `origin/<base>` into the
   run branch, and re-pushes a missing branch, but it NEVER force-pushes, deletes, or discards.
   Harvest its verdict JSON (`{ reconciled, actions, needs_prompt, blocked, evidence }`):
   - `blocked: true` → the run cannot be made resumable automatically (a merge conflict, a
     missing source SHA). Report `evidence` and STOP — do not hand off to resume.
   - `needs_prompt: [...]` non-empty → for EACH entry, one `AskUserQuestion` (approve / skip)
     before anything destructive happens. The agent did NOT act on these — on **approve**, the
     orchestrator (which holds the authority the read-mostly agent lacks) performs that single
     op itself (e.g. delete the named orphan branch); on **skip**, leave it. Never force-push to
     satisfy a prompt; if reconciliation genuinely requires a force, that is a STOP, not a fix.
   - `reconciled: true` with no remaining `needs_prompt`/`blocked` → drift is cleared; proceed.

   Only once the agent reports `reconciled` (or every `needs_prompt` was resolved by an approved
   op) is the run safe to resume.

7. **Re-scan to confirm (optional).** A second `scan` should show the reset tasks now
   `runnable` and `would_deadlock: false`. `apply` is idempotent, so a re-run is a safe no-op.

8. **Hand off to resume.** Invoke the orchestrator skill directly (the autonomous path — no
   human round-trip):

   ```
   Skill(pipeline-orchestrator)   # then run its resume entry: factory resume [--run <id>]
   ```

   - `{ kind: "resumed", run }` → continue the Phase 3 run loop; the driver now picks up the
     reset (and reopened) tasks.
   - `{ kind: "still-blocked", run_id, status, reason, resets_at_epoch? }` → the quota window
     has not recovered. Report `reason` (+ `resets_at_epoch` if present) and stop; the reset
     state is durable and a later resume continues from it.

   Do not tell the user to type `/factory:resume` themselves — calling the skill directly
   is the autonomous path. The slash command is only the manual-narration fallback.

## When NOT to use rescue

- The run is **running and healthy** — let it finish; don't reset live work.
- The only problem is the **quota gate** — that is plain `factory resume`, no rescue needed.
- The drops are genuine **dead-ends** and nothing upstream changed — finalizing `failed` (a
  report + one comment on the PRD issue listing the drops, `develop` untouched) is the correct
  outcome, not a reset.

## References

- `reference/disposition-taxonomy.md` — the five dispositions, apply semantics, and the
  GitHub-side drift that v1 explicitly defers.
- `reference/diagnostic-agent-contract.md` — the `rescue-diagnostic` input/output contract.

## Error handling

- `scan`/`apply` exit non-zero → surface the stderr verbatim; no state changes on a `scan`
  failure (it is read-only), and `apply` mutates under a lock so a failed apply leaves the run
  consistent.
- `apply --task <id>` on a `done` task → LOUD error (would un-ship); fix the id and retry.
- A `rescue-diagnostic` agent that errors or returns unparseable JSON → treat as `no-action`
  (leave the task dropped); never reset on a guess.
- User cancels at the dead-end prompt → exit cleanly; any default `apply` already done stays
  (it is idempotent and safe).
