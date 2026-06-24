/**
 * WS12 — rescue WORK ASSESSMENT (read-only recoverable-work survey).
 *
 * A run that fails before any task ships leaves each task's tests+impl committed to
 * a LOCAL branch `factory/<run>/<task>` — never pushed (the push happens in `ship`,
 * AFTER verify). The pure {@link scanRun} classifies tasks from `failure_class`
 * alone, so it cannot tell a dropped task that carries real committed work from an
 * empty one. {@link assessWork} fills that gap: for every non-shipped branched task
 * it reports whether the branch still exists and how many commits it carries above
 * the run's staging base.
 *
 * This is EVIDENCE for the operator / rescue-diagnostic, NOT an action: nothing here
 * (or in `rescue apply`) reuses or deletes a commit. Resume still discards a reset
 * task's branch via `checkout -B … origin/staging-<run-id>` and redoes the work — the
 * safe default, since verify-failed commits are exactly what a reviewer rejected.
 *
 * It is kept SEPARATE from `scanRun` (which stays pure over {@link RunState}) so the
 * git-touching part is isolated behind an injected {@link WorkProbe} — trivially
 * testable, and the scan classification has no new dependency.
 */
import { resolveStagingBranch } from "../git/run-staging.js";
import type { RunState } from "../types/index.js";

/**
 * The narrow, read-only git surface {@link assessWork} needs, injected so the
 * function is pure over its probe (production binds it to a real GitClient; tests
 * pass a fake). Both refs are full git refs (heads, remote-tracking, or shas).
 */
export interface WorkProbe {
  /** True iff `ref` resolves to a commit. */
  refExists(ref: string): Promise<boolean>;
  /** Count commits reachable from `branch` but not `base`. Both must resolve. */
  commitsAhead(base: string, branch: string): Promise<number>;
}

/** One non-shipped task's recoverable-work assessment. */
export interface TaskWork {
  task_id: string;
  /** The local task branch (`factory/<run>/<task>`). */
  branch: string;
  /** True iff the branch ref still resolves (a `--cleanup` may have deleted it). */
  branch_exists: boolean;
  /**
   * Commits on the branch above the run's staging base — the size of the
   * recoverable work. `null` when the base or the branch is unresolvable (nothing
   * to count against), NOT zero (which means "branch exists but adds nothing").
   */
  commits_ahead: number | null;
  pr_number?: number;
}

/** The read-only recoverable-work survey appended to a {@link scanRun} report. */
export interface WorkAssessment {
  /** The base ref each branch is measured against (`origin/staging-<run-id>`). */
  base_ref: string;
  /**
   * False when `base_ref` no longer resolves (e.g. a superseded/`--cleanup`'d run
   * whose remote staging branch was deleted); every `commits_ahead` is then `null`.
   */
  base_resolved: boolean;
  /** One line per non-shipped branched task, in `run.tasks` order. */
  tasks: TaskWork[];
}

/**
 * Survey a run's non-shipped task branches for recoverable committed work. Pure over
 * the injected {@link WorkProbe}; never writes state, never reuses or deletes a
 * commit. See the module header for the evidence-not-action contract.
 *
 * Skips `done` (already merged → its local commits are meaningless) and branchless
 * tasks (never reached preflight → no work to recover).
 */
export async function assessWork(run: RunState, probe: WorkProbe): Promise<WorkAssessment> {
  // The SAME per-run base the gates diff against — `staging-<run-id>` (hyphen), via
  // the pinned name when present. A generic `staging` would yield wrong counts.
  const baseRef = `origin/${resolveStagingBranch(run.run_id, run.staging_branch)}`;
  const baseResolved = await probe.refExists(baseRef);

  const tasks: TaskWork[] = [];
  for (const t of Object.values(run.tasks)) {
    if (t.status === "done") continue;
    if (t.branch === undefined) continue;
    const branchExists = await probe.refExists(t.branch);
    const commitsAhead =
      baseResolved && branchExists ? await probe.commitsAhead(baseRef, t.branch) : null;
    tasks.push({
      task_id: t.task_id,
      branch: t.branch,
      branch_exists: branchExists,
      commits_ahead: commitsAhead,
      ...(t.pr_number !== undefined ? { pr_number: t.pr_number } : {}),
    });
  }

  return { base_ref: baseRef, base_resolved: baseResolved, tasks };
}
