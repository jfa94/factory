# Rescue Disposition Taxonomy

`factory rescue scan` classifies every task into one of five dispositions (pure over run
state) and reports whether a re-drive would deadlock. There are no tiers and no issue-IDs;
GitHub truth arrives separately in the envelope's `github` section (the reconcile module —
see the last section) and never changes a disposition.

## The five dispositions

| Disposition   | Task shape                                                             | What rescue does                                                                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shipped`     | `status: done` (merged into staging)                                   | **Never touched.** Resetting would un-ship merged work. An explicit `--task` on it is a LOUD error.                                                                                                     |
| `runnable`    | `status: pending`                                                      | Nothing — the runner already picks it up on the next re-drive.                                                                                                                                          |
| `stuck`       | in-flight: `status: executing` / `reviewing` / `shipping`              | **Resettable.** A crashed/suspended session left it mid-stage with no determination. Default apply resets it to `pending`.                                                                              |
| `recoverable` | `status: dropped` + `failure_class: blocked-environmental`             | **Resettable.** The blocker (flaky env, a dep that has since reset) may have cleared. Default apply re-attempts it.                                                                                     |
| `dead-end`    | `status: dropped` + `failure_class: spec-defect` / `capability-budget` | **Left dropped by default.** Re-running repeats a determined failure. Reset ONLY via `--include-dead-ends` or an explicit `--task <id>` (each is a human/diagnostic assertion the root cause is fixed). |

Derived sets in the scan envelope:

- `resettable` = `stuck` ∪ `recoverable` — what a **default** `apply` resets.
- `dead_ends` = the `dead-end` task ids — reset only on explicit assertion.
- `needs_rescue` = `resettable.length > 0` OR a failed e2e verdict/assessment, a failed
  traceability audit, or a pending rollup — run-level blocks only an explicit apply flag clears.
- `would_deadlock` = non-terminal work remains but **no** task is actionable (none ready,
  none cascade-droppable). This is exactly the shape the orchestrator throws on — the signal that
  `factory resume` alone cannot recover the run and rescue is required first. A terminal
  `partial`/`failed` run is never `would_deadlock` (it already finalized) but may still be
  `needs_rescue` (recoverable drops to retry on reopen).

## Why `failure_class` drives the dead-end / recoverable split

The closed failure-class enum (Decision 22) is what makes "without repeating dead ends"
(the WS12 acceptance) mechanical rather than a judgment call:

- `blocked-environmental` → the failure was **outside** the producer's control; the world may
  have changed → **recoverable**.
- `spec-defect` → the spec cannot satisfy a criterion; retrying the same spec repeats it.
- `capability-budget` → the model exhausted the escalation ladder on a real ceiling; retrying
  the same model repeats it.

The last two are **dead-ends** unless something upstream actually changed (the spec was
amended, a stronger model is available). Asserting that is a human act — `--include-dead-ends`
for the whole set, or `--task <id>` for one — and that assertion is exactly what the
`rescue-diagnostic` agent helps make for an ambiguous case.

## Apply semantics (the consumer of this taxonomy)

`factory rescue apply` is the only mutation. On the locked snapshot it:

1. **Default** (no `--task`): resets `resettable` (stuck ∪ recoverable); with
   `--include-dead-ends`, also resets `dead_ends`.
2. **Explicit** (`--task <id>`, repeatable): resets exactly those ids — overriding the default
   set. A `done` id is a LOUD error (would un-ship); a `pending` id is a no-op (`skipped`); a
   named dead-end **is** reset (naming it is the assertion, no `--include-dead-ends` needed).
3. **Reopen:** if the run was terminal (`partial`/`failed`) and there was work to reset, flips
   it back to `running` with `ended_at: null` so the runner re-drives it.

A reset clears the stale producer/reviewer/drop state (`escalation_rung → 0`, `reviewers → []`,
drops `failure_class`/`failure_reason`/`producer_role`/`started_at`/`ended_at`) but **preserves**
identity, dependency edges, the spec-time risk dial, and the git/PR pointers — so an existing
branch/PR is reused on the next attempt (idempotent create, Δ P). Apply is idempotent: a second
run finds nothing resettable and is a no-op with `reopened: false`.

## GitHub-side drift — DETECTED by the reconcile module (repair still manual)

The reconcile module (`src/rescue/reconcile.ts`, P1) probes GitHub through the gh seam and
classifies state↔GitHub drift; the scan envelope embeds its report under `github` and
`factory reconcile` emits it standalone. Detection ≠ repair: `apply` still never mutates
GitHub — each drift line's `detail` names the manual remedy. The old bash issue-taxonomy
(`I-01`..`I-16`) remains **reference, not a port**:

| Drift (old issue id)                                   | Status                                                   | Remedy (manual until the P1 write phase)                                         |
| ------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| PR merged but state not `done` (`I-03`)                | detected — `merged-unrecorded`                           | Confirm on GitHub, then re-run the task's ship stage / record manually.          |
| PR exists but `pr_url`/`pr_number` unrecorded (`I-04`) | detected — `stale-pr-number` / `pr-unrecorded`           | The next attempt's idempotent create re-discovers the PR by head branch.         |
| Stale CI status (`I-05`)                               | deferred                                                 | Re-running ship re-derives CI; verdicts are derive-don't-store anyway.           |
| PR merge conflict with base (`I-07`/`I-13`)            | deferred                                                 | Rebase the task branch by hand, or reset the task to redo it from staging tip.   |
| PR closed unmerged (`I-08`)                            | detected — `closed-unmerged`                             | Reset the task with `--task <id>` to reopen the work.                            |
| Orphan branch / worktree (`I-02`/`I-14`)               | local: `work` survey; staging gone: `staging-missing`    | `git worktree remove` / `git branch -D` by hand after confirming no unique work. |
| Duplicate PRs for one branch (`I-15`)                  | visible in `github.facts` (raw `prs` per head); no class | Close the extras on GitHub; idempotent create won't make new ones.               |
| Landed auto-armed rollup                               | detected — `rollup-landed`                               | `apply --recheck-rollup` (asserts the queued merge landed).                      |
| Deleted head of a recorded OPEN PR                     | detected — `branch-missing`                              | Re-push the branch (rescue-reconciler's forward-only territory) before resume.   |
| Stale state lock (`I-01`)                              | n/a                                                      | `proper-lockfile` is self-healing; no manual lock-dir cleanup needed.            |
| Archived-run rehydration                               | removed                                                  | Runs are not archived/rehydrated; scan/apply target a live run dir.              |

The forward-only adoption WRITES (mark merged work `done`, re-push a gone branch) are P1's
next phase — see `src/rescue/reconcile.ts`'s module header and `src/rescue/scan.ts`'s
SCOPE note.
