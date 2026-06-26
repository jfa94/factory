/**
 * WS12 — rescue APPLY (the writer the SCAN feeds; Decision 22, Δ S).
 *
 * `scanRun` (scan.ts) classifies a stalled run; `applyRescue` is the only mutation
 * that acts on that classification. It resets the resettable tasks back to `pending`
 * (clearing the stale producer/reviewer/drop state) and, if the run had already
 * finalized to a terminal status, REOPENS it to `running` so the driver picks the
 * reset work back up. After apply, a plain `factory run resume` (quota gate) +
 * re-drive carries the run forward — rescue is the missing seam between them.
 *
 * THE "without repeating dead ends" CONTRACT (WS12 acceptance), enforced here:
 *   - DEFAULT apply resets `scan.resettable` = stuck (crashed in-flight) ∪
 *     recoverable (`dropped` + `blocked-environmental`, blocker may have cleared).
 *   - DEAD-END drops (`spec-defect` / `capability-budget`) are LEFT dropped — a
 *     re-attempt just repeats a determined failure. They reset ONLY when a human
 *     asserts the root cause is fixed, via `includeDeadEnds` (the CLI
 *     `--include-dead-ends` flag).
 *   - A `done` task is NEVER reset — that would un-ship merged work; an explicit
 *     `--task <done-id>` is a LOUD error, not a silent skip.
 *
 * Pure-ish: the only side effect is one locked `StateManager.update`. All
 * classification logic is delegated to the pure {@link scanRun}; the actual reset
 * is computed INSIDE the update mutator (on the locked snapshot) so a concurrent
 * writer cannot race the scan against the write.
 */
import { scanRun } from "./scan.js";
import type { StateManager } from "../core/state/index.js";
import { isTerminalRunStatus } from "../types/index.js";
import type { RunState, RunStatus, TaskState } from "../types/index.js";

/** Options narrowing what a `rescue apply` resets. */
export interface RescueApplyOptions {
  /**
   * Explicit task ids to reset. When provided (non-empty) it OVERRIDES the
   * default resettable set: each named task is reset unless it is `done` (a LOUD
   * error — would un-ship) or already `pending` (a no-op, recorded in `skipped`).
   * A missing id is a LOUD error. Naming a task is itself the human assertion, so
   * an explicit dead-end IS reset (no `--include-dead-ends` needed).
   */
  tasks?: readonly string[];
  /**
   * Also reset dead-end drops (`spec-defect`/`capability-budget`). Ignored when
   * explicit `tasks` are given (those are reset regardless). The human is
   * asserting the root cause is fixed; default is `false` (don't repeat dead ends).
   */
  includeDeadEnds?: boolean;
}

/** What a `rescue apply` did. */
export interface RescueApplyResult {
  run_id: string;
  /** The run status AFTER apply (`running` if it was reopened). */
  run_status: RunStatus;
  /** Task ids reset to `pending` (in run.tasks order, or `tasks` order if explicit). */
  reset: string[];
  /** True iff a terminal run was reopened to `running` (had work to reset). */
  reopened: boolean;
  /** Explicitly-named ids that were no-ops because already `pending`. */
  skipped: string[];
}

/**
 * Reset one task row to a clean `pending` state. Drops the stale producer dial
 * position, panel results, drop classification, lifecycle timestamps, phase cursor,
 * and merge re-sync budget; PRESERVES identity, the dependency edges, the spec-time
 * risk dial, and the git/PR pointers (so an existing branch/PR is reused on the next
 * attempt — idempotent-create, Δ P).
 * `failure_class`/`failure_reason` MUST be dropped: the schema forbids them on any
 * non-dropped status (refineTaskCrossFields), so a reset that kept them would fail
 * re-validation.
 */
function resetTaskRow(task: TaskState): TaskState {
  // Destructure OUT the fields a reset must clear; keep the rest verbatim.
  const {
    failure_class: _failureClass,
    failure_reason: _failureReason,
    producer_role: _producerRole,
    started_at: _startedAt,
    ended_at: _endedAt,
    phase: _phase,
    ...rest
  } = task;
  return {
    ...rest,
    status: "pending",
    escalation_rung: 0,
    reviewers: [],
    merge_resyncs: 0,
  };
}

/**
 * Choose which tasks to reset from a scanned run. Returns the target ids plus the
 * explicitly-named ids skipped for already being `pending`. THROWS on an explicit
 * id that is missing or `done`. See {@link RescueApplyOptions}.
 */
function selectTargets(
  run: RunState,
  opts: RescueApplyOptions,
): { targets: string[]; skipped: string[] } {
  const explicit = opts.tasks ?? [];
  if (explicit.length > 0) {
    const targets: string[] = [];
    const skipped: string[] = [];
    for (const id of explicit) {
      const task = run.tasks[id];
      if (task === undefined) {
        throw new Error(`rescue: run '${run.run_id}' has no task '${id}'`);
      }
      if (task.status === "done") {
        throw new Error(
          `rescue: refusing to reset shipped task '${id}' (status 'done') — would un-ship merged work`,
        );
      }
      if (task.status === "pending") {
        skipped.push(id); // already runnable — nothing to reset
        continue;
      }
      targets.push(id);
    }
    return { targets, skipped };
  }

  // Default: the scan's resettable set, plus dead-ends only when asserted-fixed.
  const scan = scanRun(run);
  const targets = opts.includeDeadEnds
    ? [...scan.resettable, ...scan.dead_ends]
    : [...scan.resettable];
  return { targets, skipped: [] };
}

/**
 * Reset a stalled run's resettable tasks to `pending` and (if it was terminal)
 * reopen it to `running`. The single mutation runs under the StateManager lock on
 * the freshly-read snapshot, so the classification can never race the write.
 * Idempotent: a second apply finds nothing resettable (the tasks are now `pending`)
 * and is a no-op with `reopened:false`.
 */
export async function applyRescue(
  state: StateManager,
  runId: string,
  opts: RescueApplyOptions = {},
): Promise<RescueApplyResult> {
  let result: RescueApplyResult | null = null;

  const updated = await state.update(runId, (run) => {
    const { targets, skipped } = selectTargets(run, opts);
    const wasTerminal = isTerminalRunStatus(run.status);
    // Only reopen a terminal run when there is actually work to pick back up —
    // reopening with nothing to do would just re-finalize to the same status.
    const reopen = wasTerminal && targets.length > 0;

    result = {
      run_id: runId,
      run_status: reopen ? "running" : run.status,
      reset: targets,
      reopened: reopen,
      skipped,
    };

    if (targets.length === 0 && !reopen) {
      return run; // pure no-op (update still stamps updated_at — harmless)
    }

    const nextTasks: Record<string, TaskState> = { ...run.tasks };
    for (const id of targets) {
      nextTasks[id] = resetTaskRow(run.tasks[id]!);
    }
    return {
      ...run,
      tasks: nextTasks,
      // Reopen: a terminal run carries no quota checkpoint (finalize cleared it),
      // so returning to `running` with `ended_at:null` satisfies every invariant.
      ...(reopen ? { status: "running" as const, ended_at: null } : {}),
    };
  });

  // `result` is always assigned by the (synchronous) mutator above.
  return { ...result!, run_status: updated.status };
}
