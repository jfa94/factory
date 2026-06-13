/**
 * WS12 — rescue SCAN (the read-only diagnostic; Decision 22, Δ S).
 *
 * A run can stop in a shape `factory run resume` cannot untangle: a crashed or
 * suspended session left tasks STUCK mid-stage (status `executing`/`reviewing`/
 * `shipping`) with no determination ever reached. The driver has no handler for a
 * stuck in-flight task — the run-level pump (`pumpRun`) THROWS "dependency cycle or deadlock" the moment
 * no task is actionable (no ready/cascade-droppable `pending` task) yet non-terminal
 * work remains. Resume never touches task state (it only clears the quota gate), so
 * resume alone cannot recover such a run.
 *
 * Rescue fills exactly that gap. `scanRun` is the PURE, read-only survey: it
 * classifies every task by what rescue can do with it and reports whether a re-drive
 * would deadlock — the input the orchestrator (and, for ambiguous drops, the
 * rescue-diagnostic agent) reasons over before calling `rescue apply`.
 *
 * "Without repeating dead ends" (the WS12 acceptance) is encoded in the disposition:
 *   - `dropped` + `blocked-environmental` → RECOVERABLE: the blocker (a flaky env, a
 *     dependency that has since been reset) may have cleared, so a default rescue
 *     re-attempts it (Decision: "prefer recovery over abandonment");
 *   - `dropped` + `spec-defect` / `capability-budget` → DEAD-END: re-running repeats a
 *     determined failure, so a default rescue LEAVES it dropped. It is reset only when
 *     a human explicitly asserts the root cause is fixed (`apply --include-dead-ends`).
 *
 * SCOPE (v1): rescue reconciles RUN STATE only. GitHub-side drift (a PR merged but not
 * recorded, an orphan worktree, a closed-unmerged PR) is NOT reconciled here — the old
 * bash issue-taxonomy is reference, not a port. This module is pure over {@link RunState}
 * so it stays trivially testable; gh reconciliation is a deferred enhancement, not a
 * silent omission.
 */
import { isTerminalTaskStatus, isTerminalRunStatus } from "../types/index.js";
import type { RunState, RunStatus, TaskStatus, FailureClass } from "../types/index.js";

/** What rescue can do with a task. */
export type RescueDisposition =
  /** `done` — merged into staging; NEVER touched (resetting would un-ship). */
  | "shipped"
  /** `pending` — already runnable; the driver will pick it up. */
  | "runnable"
  /** in-flight (`executing`/`reviewing`/`shipping`) — crashed mid-stage; resettable. */
  | "stuck"
  /** `dropped` + `blocked-environmental` — the blocker may have cleared; resettable. */
  | "recoverable"
  /** `dropped` + `spec-defect`/`capability-budget` — re-running repeats it; left alone. */
  | "dead-end";

/** One task's rescue classification. */
export interface RescueTaskLine {
  task_id: string;
  status: TaskStatus;
  disposition: RescueDisposition;
  failure_class?: FailureClass;
  failure_reason?: string;
  branch?: string;
  pr_number?: number;
}

/** The read-only rescue diagnostic for a run. Deterministic given the run state. */
export interface RescueScan {
  run_id: string;
  run_status: RunStatus;
  counts: {
    total: number;
    shipped: number;
    runnable: number;
    stuck: number;
    recoverable: number;
    dead_end: number;
  };
  /** Tasks a DEFAULT `rescue apply` resets to pending (stuck ∪ recoverable). */
  resettable: string[];
  /** Dropped dead-ends reset only with `--include-dead-ends` (+ a real fix). */
  dead_ends: string[];
  /** True iff there is anything for rescue to reset. */
  needs_rescue: boolean;
  /**
   * True iff a re-drive would THROW: non-terminal work remains but no task is
   * actionable (none ready, none cascade-droppable) — the driver's deadlock guard.
   * A terminal `partial`/`failed` run is never "deadlocked" (it already finalized);
   * it may still be `needs_rescue` (recoverable drops to retry on reopen).
   */
  would_deadlock: boolean;
  /** One-line human summary. */
  summary: string;
  /** Per-task lines, in run.tasks order. */
  tasks: RescueTaskLine[];
}

/** Classify one task. */
function dispositionOf(
  status: TaskStatus,
  failureClass: FailureClass | undefined,
): RescueDisposition {
  if (status === "done") return "shipped";
  if (status === "pending") return "runnable";
  if (status === "dropped") {
    return failureClass === "blocked-environmental" ? "recoverable" : "dead-end";
  }
  // executing | reviewing | shipping
  return "stuck";
}

// The engine's readiness predicates, mirrored here so scan stays decoupled from the
// run-level pump. These are DEFINITIONAL (the meaning of "ready" / "blocked") and stable;
// the source of truth is src/driver/next.ts (depsSatisfied / isUnsatisfiableDep).
function depsSatisfied(run: RunState, depends: readonly string[]): boolean {
  return depends.every((d) => run.tasks[d]?.status === "done");
}
function hasUnsatisfiableDep(run: RunState, depends: readonly string[]): boolean {
  return depends.some((d) => {
    const dep = run.tasks[d];
    return dep === undefined || dep.status === "dropped";
  });
}

/**
 * Survey a run and classify every task for rescue. Pure + read-only — no state
 * writes, no gh, no agent spawns (the diagnostic LLM is the orchestrator's job;
 * this is its input). See the module header for the disposition contract.
 */
export function scanRun(run: RunState): RescueScan {
  const all = Object.values(run.tasks);
  const tasks: RescueTaskLine[] = all.map((t) => ({
    task_id: t.task_id,
    status: t.status,
    disposition: dispositionOf(t.status, t.failure_class),
    ...(t.failure_class !== undefined ? { failure_class: t.failure_class } : {}),
    ...(t.failure_reason !== undefined ? { failure_reason: t.failure_reason } : {}),
    ...(t.branch !== undefined ? { branch: t.branch } : {}),
    ...(t.pr_number !== undefined ? { pr_number: t.pr_number } : {}),
  }));

  const by = (d: RescueDisposition): RescueTaskLine[] => tasks.filter((t) => t.disposition === d);
  const stuck = by("stuck");
  const recoverable = by("recoverable");
  const deadEnd = by("dead-end");

  const resettable = [...stuck, ...recoverable].map((t) => t.task_id);
  const dead_ends = deadEnd.map((t) => t.task_id);

  const allTerminal = all.every((t) => isTerminalTaskStatus(t.status));
  // A pending task is "actionable" to the driver: it either runs (deps done) or is
  // cascade-dropped (a dep dropped/missing). If no task is actionable yet non-terminal
  // work remains, a re-drive throws — that is `would_deadlock`.
  const actionablePending = all.some(
    (t) =>
      t.status === "pending" &&
      (depsSatisfied(run, t.depends_on) || hasUnsatisfiableDep(run, t.depends_on)),
  );
  const would_deadlock = !allTerminal && !actionablePending;
  const needs_rescue = resettable.length > 0;

  return {
    run_id: run.run_id,
    run_status: run.status,
    counts: {
      total: all.length,
      shipped: by("shipped").length,
      runnable: by("runnable").length,
      stuck: stuck.length,
      recoverable: recoverable.length,
      dead_end: deadEnd.length,
    },
    resettable,
    dead_ends,
    needs_rescue,
    would_deadlock,
    summary: summarize(run.status, resettable.length, dead_ends.length, would_deadlock),
    tasks,
  };
}

/** Build the one-line summary. */
function summarize(
  status: RunStatus,
  resettable: number,
  deadEnds: number,
  wouldDeadlock: boolean,
): string {
  if (resettable === 0) {
    const tail =
      deadEnds > 0 ? ` (${deadEnds} dead-end drop(s) — need a fix + --include-dead-ends)` : "";
    return `run '${status}': no rescue needed${tail}`;
  }
  const reopen = isTerminalRunStatus(status) ? " (will reopen the run)" : "";
  const deadlock = wouldDeadlock ? "; a re-drive would deadlock without rescue" : "";
  return `run '${status}': rescue can reset ${resettable} task(s)${reopen}${deadlock}`;
}
