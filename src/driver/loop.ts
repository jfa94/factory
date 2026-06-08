/**
 * WS10 — the in-process DRIVER (the Model-A ACTOR).
 *
 * ARCHITECTURE (settled — see types.ts). A handler REPORTS a {@link StageResult};
 * the driver ACTS on it. {@link driveTask}/{@link driveRun} own EVERYTHING a
 * reporter is forbidden:
 *
 *   - ALL StateManager writes (in-flight status, producer_role, reviewers,
 *     branch/pr_number, the classified drop, the run-level finalize/quota patch).
 *   - ALL Agent() spawns, via the injected {@link DriverRunners} (producer,
 *     reviewers, holdout-validator, finding-verifier, source reader, scribe).
 *   - The per-invocation RE-EXPRESSION of the producer escalation ladder via the
 *     persisted `escalation_rung` (Δ D / Decision 25): a classified-retry bumps the
 *     rung and resumes at the producer stage; the handler re-dials off the new rung.
 *     There is NO `runLadder` here — v1 re-expresses only the OUTER ladder.
 *   - Run-level quota pacing (epoch SECONDS via {@link DriveDeps.now}).
 *
 * VERIFY + SHIP are LOOP-OWNED (special-cased), not dispatched through the engine:
 *   - verify needs a holdout-validate Agent spawn (a handler cannot spawn) folded
 *     into the floor as gate evidence BEFORE the panel runs, then the panel spawn +
 *     verify-then-fix (runPanel) + the per-reviewer persist.
 *   - ship needs pr_number capture + the serial MergeSerializer (live mode).
 * The `handler.verify`/`handler.ship` reporters exist for the CLI single-step path
 * (Task C) and deliberately do LESS (no holdout, no merge); the divergence is
 * structural and accepted. preflight/tests/exec go through {@link runStage}.
 */
import {
  runStage,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  classifyFailure,
  ESCALATION_CAP,
  buildPanelManifest,
  resolveReviewModel,
  runPanel,
  GateRunner,
  checkHoldout,
  holdoutEvidence,
  evaluateQuota,
  decisionToStageResult,
  buildCheckpoint,
  clearCheckpoint,
  assertNever,
  type GateContext,
  type GateEvidence,
  type RunState,
  type SpawnManifest,
  type StageContext,
  type StageHandlers,
  type StageResult,
  type TaskStage,
  type TaskState,
} from "./deps.js";
import type { DriveDeps } from "./types.js";
import {
  markInFlight,
  completeTask,
  dropTask,
  dropStep,
  escalateOrDrop,
  applyProducerOutcome,
  type TaskOutcome,
  type TaskStep,
} from "./transitions.js";
import { shipTask } from "./ship.js";
import { finalizeRun } from "./finalize.js";
import { makeStageHandlers } from "./handlers.js";
import { spawnProducer, spawnReviewers, asProducerRole } from "./agent-runner.js";
import { taskWorktreePath } from "./paths.js";
import { createLogger } from "../shared/index.js";

const log = createLogger("driver");

/**
 * A per-task local budget for the live serial-writer "behind / not-mergeable"
 * re-sync route. This is NOT a capability failure (it does not burn an escalation
 * rung); persistent staging contention is bounded so a task can't spin, and on
 * exhaustion the task drops LOUDLY as `blocked-environmental`.
 *
 * The narrow {@link import("./deps.js").GitClient} intentionally has no merge and
 * no force-push, so the only actor that can bring a BEHIND branch up to date is the
 * executor in its worktree — hence the re-route to `exec` rather than a driver-side
 * git merge.
 */
const MERGE_RESYNC_CAP = 8;

/** Mutable per-task budget threaded through one {@link driveTask} run. */
interface ResyncBudget {
  mergeResyncs: number;
}

/** The wait-retry variant, narrowed for the act-on-result switch. */
type WaitRetry = Extract<StageResult, { kind: "wait-retry" }>;

// ---------------------------------------------------------------------------
// Per-task drive
// ---------------------------------------------------------------------------

/**
 * Drive ONE task from preflight to a terminal outcome (done / dropped). Builds the
 * reporter {@link StageHandlers} once, then loops: mark the in-flight status,
 * snapshot the frozen context, get the stage result (engine for preflight/tests/
 * exec; loop-owned runVerify/runShip for verify/ship), and ACT on it. Throws loud
 * on a run-scope result reaching a task stage (graceful-stop / finalize-terminal).
 */
export async function driveTask(
  deps: DriveDeps,
  runId: string,
  taskId: string,
): Promise<TaskOutcome> {
  const handlers = makeStageHandlers(deps);
  const budget: ResyncBudget = { mergeResyncs: 0 };
  let stage: TaskStage = "preflight";
  for (;;) {
    await markInFlight(deps, runId, taskId, stage);
    const ctx = await buildTaskCtx(deps, runId, taskId);
    const result = await stageResultFor(deps, handlers, stage, ctx);
    const step = await act(deps, runId, taskId, stage, result, budget);
    if (step.done) return step.outcome;
    stage = step.stage;
  }
}

/** Build the frozen per-task {@link StageContext} from a fresh state read. */
async function buildTaskCtx(deps: DriveDeps, runId: string, taskId: string): Promise<StageContext> {
  const run = await deps.state.read(runId);
  const task = run.tasks[taskId];
  if (task === undefined) {
    throw new Error(`driver: run '${runId}' has no task '${taskId}'`);
  }
  return { run, task, attempt: task.escalation_rung + 1 };
}

/**
 * Dispatch one stage to its result source. preflight/tests/exec go through the
 * pure engine ({@link runStage} → the reporter). verify/ship are loop-owned (they
 * spawn agents / merge — a reporter cannot).
 */
function stageResultFor(
  deps: DriveDeps,
  handlers: StageHandlers,
  stage: TaskStage,
  ctx: StageContext,
): Promise<StageResult> {
  if (stage === "verify") return runVerify(deps, ctx);
  if (stage === "ship") return shipTask(deps, ctx);
  return runStage(stage, ctx, handlers);
}

// ---------------------------------------------------------------------------
// Act on a stage result
// ---------------------------------------------------------------------------

/** Translate a {@link StageResult} into the next loop step (the driver's effects). */
async function act(
  deps: DriveDeps,
  runId: string,
  taskId: string,
  stage: TaskStage,
  result: StageResult,
  budget: ResyncBudget,
): Promise<TaskStep> {
  switch (result.kind) {
    case "advance":
      return { done: false, stage: result.to };
    case "spawn-agents":
      return actSpawn(deps, runId, taskId, stage, result.manifest);
    case "wait-retry":
      return actWaitRetry(deps, runId, taskId, result, budget);
    case "task-terminal":
      return result.outcome.outcome === "done"
        ? completeTask(deps, runId, taskId)
        : dropStep(deps, runId, taskId, result.outcome.failure_class, result.outcome.reason);
    case "graceful-stop":
      throw new Error(
        `driver: stage '${stage}' returned graceful-stop in task scope — ` +
          `quota is a run-level gate, never a task stage`,
      );
    case "finalize-terminal":
      throw new Error(
        `driver: stage '${stage}' returned finalize-terminal in task scope — ` +
          `finalize is run-level only`,
      );
    default:
      return assertNever(result);
  }
}

/**
 * Act on a producer spawn manifest. The in-process loop only reaches `spawn-agents`
 * from the producer stages (tests/exec) — verify/ship are loop-owned and never
 * dispatched through a handler, so a panel/holdout manifest never arrives here. One
 * producer agent per manifest: run it, record `producer_role` on success, else
 * classify the outcome and escalate-or-drop (resuming at the SAME producer stage).
 */
async function actSpawn(
  deps: DriveDeps,
  runId: string,
  taskId: string,
  stage: TaskStage,
  manifest: SpawnManifest,
): Promise<TaskStep> {
  const agent = manifest.agents[0];
  if (agent === undefined) {
    throw new Error(`driver: empty spawn manifest at stage '${stage}'`);
  }
  const outcome = await spawnProducer(agent, runId, deps, deps.runners.producer);
  return applyProducerOutcome(
    deps,
    runId,
    taskId,
    { role: asProducerRole(agent.role), stage, stageAfter: manifest.stage_after },
    outcome,
  );
}

/**
 * Act on a bounded wait-retry. Two sources reach the in-process loop:
 *   - ship: the live serial-writer refused the merge (behind / not-mergeable) →
 *     re-route to the producer (exec) to re-sync the branch with staging, bounded
 *     by {@link MERGE_RESYNC_CAP}; exhaustion drops `blocked-environmental`.
 *   - verify: the verifier floor blocked → classify floor-blocked → escalate the
 *     producer ladder (bump rung, re-implement), bounded by {@link ESCALATION_CAP}.
 */
function actWaitRetry(
  deps: DriveDeps,
  runId: string,
  taskId: string,
  result: WaitRetry,
  budget: ResyncBudget,
): Promise<TaskStep> {
  if (result.stage === "ship") {
    if (budget.mergeResyncs >= MERGE_RESYNC_CAP) {
      return dropStep(
        deps,
        runId,
        taskId,
        "blocked-environmental",
        `serial merge blocked after ${MERGE_RESYNC_CAP} re-sync attempts: ${result.reason}`,
      );
    }
    budget.mergeResyncs += 1;
    log.info(
      `task '${taskId}' merge refused (${result.reason}); re-routing to exec to re-sync ` +
        `(attempt ${budget.mergeResyncs}/${MERGE_RESYNC_CAP})`,
    );
    return Promise.resolve({ done: false, stage: "exec" });
  }
  // verify floor-block — the only other wait-retry source in the in-process loop.
  return escalateOrDrop(
    deps,
    runId,
    taskId,
    classifyFailure({ kind: "floor-blocked", reason: result.reason }),
    "exec",
  );
}

// ---------------------------------------------------------------------------
// verify (loop-owned): gates → holdout-validate → panel → verify-then-fix
// ---------------------------------------------------------------------------

/**
 * The loop-owned verify pass (vs the holdout-less CLI reporter handler.verify):
 *   1. deterministic gates → gate evidence,
 *   2. holdout-validate (a loop-owned agent spawn) folded into the floor as
 *      `{gate:"holdout"}` evidence BEFORE the panel runs — only when the tests
 *      stage persisted an answer key (a degenerate withheld-0 split persists none),
 *   3. spawn the risk-invariant panel against the worktree,
 *   4. verify-then-fix (citation-verify + independent confirmation) + DERIVE the
 *      floor via runPanel,
 *   5. persist the per-reviewer results (the driver owns state writes).
 * Returns the panel's {@link StageResult} (advance→ship on a clear floor, else a
 * bounded wait-retry the loop escalates).
 */
async function runVerify(deps: DriveDeps, ctx: StageContext): Promise<StageResult> {
  const task = requireCtxTask(ctx, "verify");
  const runId = ctx.run.run_id;
  const worktree = taskWorktreePath(deps.dataDir, runId, task.task_id);

  // 1. deterministic gates.
  const gateCtx: GateContext = {
    runId,
    taskId: task.task_id,
    worktree,
    baseRef: deps.config.git.stagingBranch,
    config: deps.config,
    tools: deps.tools,
  };
  const gate = await new GateRunner().run(gateCtx);
  const gateEvidence: GateEvidence[] = [...gate.evidence];

  // 2. holdout-validate (Δ Y) — folded into the floor as gate evidence.
  if (await deps.holdout.has(runId, task.task_id)) {
    const record = await deps.holdout.get(runId, task.task_id);
    const verdicts = await deps.runners.holdoutValidator.validate({
      taskId: task.task_id,
      worktree,
      withheldCriteria: record.withheld_criteria,
      model: resolveReviewModel(deps.config),
      maxTurns: deps.config.review.maxTurnsDeep,
    });
    const check = checkHoldout(record, verdicts, deps.config.quality.holdoutPassRate);
    gateEvidence.push(holdoutEvidence(check));
  }

  // 3. spawn the risk-invariant panel.
  const manifest = buildPanelManifest(
    "verify",
    resolveReviewModel(deps.config),
    deps.config.review.maxTurnsDeep,
  );
  const reviews = await spawnReviewers(
    manifest.agents,
    worktree,
    task.task_id,
    deps.runners.reviewer,
  );

  // 4. verify-then-fix + derive the floor. The wait-retry accounting mirrors the
  //    outer ladder: attempt = rung + 1, max = cap + 1 (rung 0..CAP).
  const panel = await runPanel({
    reviews,
    source: deps.runners.source,
    makeRunner: deps.runners.makeVerifier,
    gateEvidence,
    stage: "verify",
    attempt: task.escalation_rung + 1,
    maxAttempts: ESCALATION_CAP + 1,
  });

  // 5. persist the per-reviewer results (coherent counts; never a stored verdict).
  const reviewerResults = [...panel.reviewerResults];
  await deps.state.updateTask(runId, task.task_id, (t) => ({ ...t, reviewers: reviewerResults }));

  return panel.result;
}

/** The task a loop-owned stage acts on; absent only for the run-level finalize. */
function requireCtxTask(ctx: StageContext, stage: string): TaskState {
  if (ctx.task === undefined) {
    throw new Error(`driver: stage '${stage}' requires a task but ctx.task is absent`);
  }
  return ctx.task;
}

// ---------------------------------------------------------------------------
// Run-level drive
// ---------------------------------------------------------------------------

/**
 * Drive a whole run to a terminal status. Each iteration:
 *   1. return early if the run is already terminal;
 *   2. finalize (terminal-by-construction) once every task is terminal;
 *   3. apply the run-level quota gate (pause/suspend on a breach) — and clear a
 *      stale checkpoint when resuming a paused/suspended run that may now proceed;
 *   4. cascade-drop tasks whose dependency dropped or is missing (blocked-
 *      environmental);
 *   5. launch the ready pending tasks (deps all done), capped at concurrency.
 * Throws loud on a deadlock (non-terminal tasks but none ready and none blocked —
 * a dependency cycle), never spins.
 */
export async function driveRun(deps: DriveDeps, runId: string): Promise<RunState> {
  for (;;) {
    const run = await deps.state.read(runId);
    if (isTerminalRunStatus(run.status)) {
      return run;
    }

    const tasks = Object.values(run.tasks);

    // All tasks terminal (vacuously true for an empty run → `failed`) → finalize.
    // The coordinator builds+persists the report, emits telemetry, files per-drop
    // issues, ships the staging→develop rollup, THEN flips the run terminal.
    if (tasks.every((t) => isTerminalTaskStatus(t.status))) {
      const { run: finalized } = await finalizeRun(deps, runId);
      return finalized;
    }

    // Run-level quota gate (epoch SECONDS via deps.now()).
    const stopped = await applyQuotaGate(deps, runId);
    if (stopped !== null) {
      return stopped;
    }
    // Quota proceeds: if we are resuming a paused/suspended run, return it to
    // `running` (drop the checkpoint) before driving any task.
    if (run.status === "paused" || run.status === "suspended") {
      const patch = clearCheckpoint();
      await deps.state.update(runId, (s) => ({ ...s, status: patch.status, quota: patch.quota }));
    }

    // Cascade-drop tasks blocked on a dropped/missing dependency.
    const blocked = tasks.filter((t) => t.status === "pending" && hasUnsatisfiableDep(run, t));
    if (blocked.length > 0) {
      for (const t of blocked) {
        const dep = firstUnsatisfiableDep(run, t);
        await dropTask(
          deps,
          runId,
          t.task_id,
          "blocked-environmental",
          `dependency '${dep}' did not complete (dropped or missing)`,
        );
      }
      continue;
    }

    const ready = tasks.filter((t) => t.status === "pending" && depsSatisfied(run, t));
    if (ready.length === 0) {
      const remaining = tasks
        .filter((t) => !isTerminalTaskStatus(t.status))
        .map((t) => `${t.task_id}=${t.status}`);
      throw new Error(
        `driveRun: no ready or blocked tasks but ${remaining.length} remain ` +
          `[${remaining.join(", ")}] — dependency cycle or deadlock`,
      );
    }

    const batch = ready.slice(0, Math.max(1, deps.concurrency));
    await Promise.all(batch.map((t) => driveTask(deps, runId, t.task_id)));
    // Loop: re-read, re-evaluate readiness / finalize.
  }
}

/** True iff every dependency of `task` is `done`. */
function depsSatisfied(run: RunState, task: TaskState): boolean {
  return task.depends_on.every((d) => run.tasks[d]?.status === "done");
}

/** True iff any dependency of `task` is dropped or missing (can never be satisfied). */
function hasUnsatisfiableDep(run: RunState, task: TaskState): boolean {
  return task.depends_on.some((d) => isUnsatisfiableDep(run, d));
}

/** The first dropped/missing dependency id of `task` (for the drop reason). */
function firstUnsatisfiableDep(run: RunState, task: TaskState): string {
  return task.depends_on.find((d) => isUnsatisfiableDep(run, d)) ?? "?";
}

/** A dependency is unsatisfiable when it is absent from the run or already dropped. */
function isUnsatisfiableDep(run: RunState, depId: string): boolean {
  const dep = run.tasks[depId];
  return dep === undefined || dep.status === "dropped";
}

/**
 * The run-level quota gate. Reads the usage signal, evaluates the two-window pacer
 * (epoch SECONDS), and on a breach persists the matching checkpoint patch + status
 * and returns the stopped run; on `proceed` returns null (the caller continues).
 * An unobservable reading fails closed → a clean `suspended` (no reset horizon).
 */
async function applyQuotaGate(deps: DriveDeps, runId: string): Promise<RunState | null> {
  const reading = await deps.usage.read();
  const decision = evaluateQuota(reading, deps.config, deps.now());
  if (decisionToStageResult(decision) === null) {
    return null; // proceed
  }
  switch (decision.kind) {
    case "pause-5h":
    case "suspend-7d": {
      const patch = buildCheckpoint(decision);
      log.warn(`run '${runId}' ${decision.kind}: ${decision.reason}`);
      return deps.state.update(runId, (s) => ({ ...s, status: patch.status, quota: patch.quota }));
    }
    case "unavailable-halt":
      log.warn(`run '${runId}' quota unavailable — suspending: ${decision.reason}`);
      return deps.state.update(runId, (s) => ({ ...s, status: "suspended", quota: undefined }));
    case "proceed":
      return null; // unreachable (decisionToStageResult==null already handled it)
    default:
      return assertNever(decision);
  }
}

// ---------------------------------------------------------------------------
// Thin class wrapper
// ---------------------------------------------------------------------------

/**
 * A thin object wrapper binding {@link driveTask}/{@link driveRun} to one
 * {@link DriveDeps}. Holds no mutable state — purely a closure over `deps` for
 * callers that prefer a handle (the CLI / v2 Workflow driver). The free functions
 * remain the primary API (tests drive them directly).
 */
export class Driver {
  constructor(private readonly deps: DriveDeps) {}

  /** See {@link driveTask}. */
  driveTask(runId: string, taskId: string): Promise<TaskOutcome> {
    return driveTask(this.deps, runId, taskId);
  }

  /** See {@link driveRun}. */
  driveRun(runId: string): Promise<RunState> {
    return driveRun(this.deps, runId);
  }
}
