/**
 * WS10 — the SHARED stateful ship pass.
 *
 * Ship is the one task stage with NO agent→record cycle: it is fully deterministic
 * git/PR I/O, so the per-task pump ({@link import("./pump.js").pumpTask}) runs this
 * logic directly rather than routing it through a reporter + a separate fold.
 *
 * Unlike the pure {@link import("./handlers.js").makeStageHandlers} `ship` reporter
 * (which opens the PR but cannot write state or merge), {@link shipTask} DOES write
 * the `branch`/`pr_number` pointers and (in `live` mode) drives the app-level serial
 * MergeSerializer — it needs the {@link StateManager}, so it lives here next to the
 * other shared state-writers ({@link import("./transitions.js")}) rather than in a
 * reporter. It still does NOT write the terminal `done` status: it returns a
 * `task-terminal` {@link StageResult} the pump folds via completeTask, keeping
 * "write done" in one place.
 */
import {
  taskDone,
  waitRetry,
  runScopedBranch,
  createTaskPrIdempotent,
  MergeSerializer,
  type MergeOutcome,
  type StageContext,
  type StageResult,
  type StateManager,
  type TaskState,
} from "./deps.js";
import { specTaskOf, shipBody } from "./handlers.js";
import type { HandlerDeps } from "./types.js";
import { createLogger } from "../shared/index.js";

const log = createLogger("ship");

/** The narrow deps shipping needs: the reporter bundle + the state write path. */
export interface ShipDeps extends HandlerDeps {
  readonly state: StateManager;
}

/** The task a ship acts on; absent only for the run-level finalize. */
function requireTask(ctx: StageContext): TaskState {
  if (ctx.task === undefined) {
    throw new Error("ship: stage 'ship' requires a task but ctx.task is absent");
  }
  return ctx.task;
}

/**
 * Open the task PR into staging IDEMPOTENTLY (look up by head first — Δ P), record
 * `branch` + `pr_number` (the reporter cannot write state), then either stop at the
 * open PR (`no-merge` cutover-safe default) or serial-merge into staging behind the
 * app-level lock (`live`). A refused merge (behind / not-mergeable) surfaces as a
 * `ship` wait-retry the caller re-routes for a re-sync. Never writes the terminal
 * `done` status — that is the caller's `completeTask`.
 */
export async function shipTask(deps: ShipDeps, ctx: StageContext): Promise<StageResult> {
  const task = requireTask(ctx);
  const runId = ctx.run.run_id;
  const specTask = specTaskOf(deps.spec, task.task_id);
  const branch = runScopedBranch(runId, task.task_id);

  const pr = await createTaskPrIdempotent({
    ghClient: deps.gh,
    branch,
    title: specTask.title,
    body: shipBody(runId, specTask),
    base: deps.config.git.stagingBranch,
  });
  await deps.state.updateTask(runId, task.task_id, (t) => ({
    ...t,
    branch,
    pr_number: pr.number,
  }));

  if (deps.shipMode !== "live") {
    // no-merge: the PR is open; staging integration is not automated (cutover net).
    return taskDone();
  }

  const serializer = new MergeSerializer({
    ghClient: deps.gh,
    owner: deps.owner,
    repo: deps.repo,
    stagingBranch: deps.config.git.stagingBranch,
    dataDir: deps.dataDir,
  });
  const outcome: MergeOutcome = await serializer.merge(pr.number);
  if (outcome.merged) {
    log.info(`task '${task.task_id}' merged PR #${pr.number} via ${outcome.via}`);
    return taskDone();
  }
  // Refused: the caller re-routes through the producer for a branch re-sync. The
  // nominal attempt/max (1,1) are unused — a per-loop budget bounds the re-route.
  return waitRetry("ship", `serial merge refused (${outcome.reason})`, 1, 1);
}
