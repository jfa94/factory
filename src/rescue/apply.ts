/**
 * WS12 — rescue APPLY (the writer the SCAN feeds; Decision 22, Δ S).
 *
 * `scanRun` (scan.ts) classifies a stalled run; `applyRescue` is the only mutation
 * that acts on that classification. It resets the resettable tasks back to `pending`
 * (clearing the stale producer/reviewer/failure state) and, if the run had already
 * finalized to a terminal status, REOPENS it to `running` so the orchestrator picks the
 * reset work back up. After apply, a plain `factory run resume` (quota gate) +
 * re-drive carries the run forward — rescue is the missing seam between them.
 *
 * THE "without repeating dead ends" CONTRACT (WS12 acceptance), enforced here:
 *   - DEFAULT apply resets `scan.resettable` = stuck (crashed in-flight) ∪
 *     recoverable (`failed` + `blocked-environmental`, blocker may have cleared).
 *   - DEAD-END failures (`spec-defect` / `capability-budget`) are LEFT failed — a
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
import { nowEpoch, parseIso8601ToEpoch } from "../shared/time.js";
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
   * Also reset dead-end failures (`spec-defect`/`capability-budget`). Ignored when
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

/** Optional overrides applied on top of a plain {@link resetTaskRow} reset. */
export interface ResetTaskRowOpts {
  /**
   * Fresh e2e-reopen feedback to stamp onto the reset row (Decision 39). When
   * omitted, whatever `e2e_feedback` the task already carries flows through
   * UNCHANGED — see the field's own note below.
   */
  e2eFeedback?: string;
}

/**
 * Reset one task row to a clean `pending` state. Drops the stale producer dial
 * position, panel results, failure classification, lifecycle timestamps, phase cursor,
 * and merge re-sync budget; PRESERVES identity, the dependency edges, the spec-time
 * risk dial, and the git/PR pointers (so an existing branch/PR is reused on the next
 * attempt — idempotent-create, Δ P).
 * `failure_class`/`failure_reason` MUST be dropped: the schema forbids them on any
 * non-failed status (refineTaskCrossFields), so a reset that kept them would fail
 * re-validation.
 *
 * `e2e_feedback` is DELIBERATELY NOT in the destructure-and-drop list below (unlike
 * `test_revision_feedback`): a plain rescue reset carries forward whatever e2e
 * feedback the task already had — the task's still-open e2e complaint is unrelated
 * to why THIS reset fired, so it isn't stale. The run-level e2e coroutine's reopen
 * loop (src/orchestrator/e2e.ts, Decision 39) reuses this SAME function, passing a
 * fresh `e2eFeedback` string via `opts` to overwrite it — one source of truth for
 * "what a reset clears/keeps", shared by both call sites. Exported for that reuse.
 */
export function resetTaskRow(task: TaskState, opts: ResetTaskRowOpts = {}): TaskState {
  // Destructure OUT the fields a reset must clear; keep the rest verbatim.
  const {
    failure_class: _failureClass,
    failure_reason: _failureReason,
    producer_role: _producerRole,
    test_revision_feedback: _testRevisionFeedback,
    started_at: _startedAt,
    ended_at: _endedAt,
    phase: _phase,
    // WS2 hygiene: mirror completeTask/failTask (transitions.ts:88,112). A stale
    // checkpoint with escalation_rung reset to 0 would re-match the orchestrator's
    // idempotent re-spawn guard (orchestrator.ts:358-373) and hard-reset the freshly
    // recreated worktree to the pre-rescue tip_sha.
    spawn_in_flight: _spawnInFlight,
    ...rest
  } = task;
  return {
    ...rest,
    status: "pending",
    escalation_rung: 0,
    reviewers: [],
    merge_resyncs: 0,
    ...(opts.e2eFeedback !== undefined ? { e2e_feedback: opts.e2eFeedback } : {}),
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
  // Snapshot now before the update so the idle gap (now - updated_at) is stable
  // even if the mutator is retried internally by the state manager.
  const now = nowEpoch();

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
      // Accumulate idle time so the runtime breaker deducts the rescue gap from wall-clock.
      ...(reopen
        ? {
            status: "running" as const,
            ended_at: null,
            paused_minutes:
              (run.paused_minutes ?? 0) +
              Math.max(0, Math.floor((now - parseIso8601ToEpoch(run.updated_at)) / 60)),
          }
        : {}),
    };
  });

  // `result` is always assigned by the (synchronous) mutator above.
  return { ...result!, run_status: updated.status };
}
