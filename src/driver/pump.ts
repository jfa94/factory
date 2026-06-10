/**
 * The per-task COROUTINE PUMP — the engine half of the `factory drive` seam.
 *
 * One invocation = "run every deterministic step you can, then stop": the pump
 * resumes at the persisted stage cursor, optionally FOLDS the previous spawn's
 * agent results (producer status / holdout raw / panel reviews — the internalized
 * record-* writers), then loops the stage machine until it either needs agents
 * (emit ONE spawn envelope and return) or the task is terminal. The process is
 * stateless: every fact it needs lives in the run store, so a crashed driver
 * just re-invokes and the same envelope re-derives (handlers are idempotent).
 *
 * This is loop.ts's driveTask with the spawn boundary inverted: where the loop
 * awaited injected DriverRunners, the pump returns the manifest to the caller.
 * Holdout-before-reviews — an Iron Law the old skill enforced by prose — is here
 * mere code ordering inside foldResults.
 */
import {
  classifyFailure,
  isTerminalTaskStatus,
  runStage,
  assertNever,
  type StageContext,
  type StageResult,
  type SpawnManifest,
  type StateManager,
  type TaskStage,
  type TaskState,
  type RunState,
} from "./deps.js";
import type { UsageSignal } from "./deps.js";
import {
  markInFlight,
  completeTask,
  dropStep,
  escalateOrDrop,
  type TaskOutcome,
  type TaskStep,
} from "./transitions.js";
import {
  applyRecordProducer,
  applyRecordHoldout,
  applyRecordReviews,
  type FoldDeps,
} from "./fold.js";
import { makeStageHandlers } from "./handlers.js";
import { shipTask } from "./ship.js";
import { taskWorktreePath } from "./paths.js";
import { applyQuotaGate, type QuotaStop } from "./quota-gate.js";
import { resolveReviewModel } from "../verifier/judgment/index.js";
import { buildHoldoutPrompt, FsHoldoutVerdictStore } from "../verifier/holdout/index.js";
import type { DriveResults } from "./results.js";
import type { HandlerDeps } from "./types.js";

/** Ship live-merge re-sync budget per task (persisted in TaskState.merge_resyncs). */
export const MERGE_RESYNC_CAP = 8;

/** What the driver must collect for the emitted manifest. */
export type DriveExpects = "producer-status" | "reviews";

/** The out-of-band holdout-validator spawn run alongside the panel (verify only). */
export interface HoldoutSidecar {
  readonly kind: "holdout-validate";
  readonly task_id: string;
  readonly worktree: string;
  readonly model: string;
  readonly max_turns: number;
  readonly prompt: string;
}

export type DriveEnvelope =
  | {
      readonly kind: "spawn";
      readonly run_id: string;
      readonly task_id: string;
      readonly stage: TaskStage;
      readonly manifest: SpawnManifest;
      readonly sidecar?: HoldoutSidecar;
      readonly expects: DriveExpects;
      readonly worktree: string;
    }
  | {
      readonly kind: "terminal";
      readonly run_id: string;
      readonly task_id: string;
      readonly outcome: TaskOutcome;
    }
  | {
      readonly kind: "quota-blocked";
      readonly run_id: string;
      readonly task_id: string;
      readonly scope: QuotaStop["scope"];
      readonly reason: string;
      readonly resets_at_epoch?: number;
    };

/** Everything the pumps need: the reporter bundle + state + the quota signal. */
export interface PumpDeps extends HandlerDeps {
  readonly state: StateManager;
  readonly usage: UsageSignal;
  /** Epoch SECONDS. */
  readonly now: () => number;
}

/** Resolve the live task row (LOUD if absent — run/spec drift). */
function requireTask(run: RunState, taskId: string): TaskState {
  const task = run.tasks[taskId];
  if (task === undefined) {
    throw new Error(`pump: run '${run.run_id}' has no task '${taskId}'`);
  }
  return task;
}

/** The terminal outcome of an already-terminal task row (idempotent re-entry). */
function terminalOutcome(task: TaskState): TaskOutcome {
  if (task.status === "done") return { outcome: "done" };
  return {
    outcome: "dropped",
    failure_class: task.failure_class ?? "blocked-environmental",
    reason: task.failure_reason ?? "dropped (no recorded reason)",
  };
}

/** Build the holdout-validate sidecar IFF an answer key was withheld for this task. */
export async function holdoutSidecar(
  deps: PumpDeps,
  runId: string,
  taskId: string,
): Promise<HoldoutSidecar | undefined> {
  if (!(await deps.holdout.has(runId, taskId))) {
    return undefined;
  }
  const record = await deps.holdout.get(runId, taskId);
  const worktree = taskWorktreePath(deps.dataDir, runId, taskId);
  return {
    kind: "holdout-validate",
    task_id: taskId,
    worktree,
    model: resolveReviewModel(deps.config),
    max_turns: deps.config.review.maxTurnsDeep,
    prompt: buildHoldoutPrompt(record, worktree),
  };
}

/** Fold the previous spawn's results into state via the shared writers. */
async function foldResults(
  deps: PumpDeps,
  runId: string,
  taskId: string,
  stage: TaskStage,
  results: DriveResults,
): Promise<TaskStep> {
  const fold: FoldDeps = deps;
  if (stage === "tests" || stage === "exec") {
    if (results.producer === undefined) {
      throw new Error(`drive: stage '${stage}' expects producer-status results`);
    }
    const env = await applyRecordProducer(
      deps.state,
      runId,
      taskId,
      stage,
      results.producer.status,
    );
    return env.step;
  }
  if (stage === "verify") {
    if (results.reviews === undefined) {
      throw new Error("drive: stage 'verify' expects reviews results");
    }
    const verdictStore = new FsHoldoutVerdictStore(deps.dataDir);
    // Holdout BEFORE reviews — the fold ordering the old skill enforced by prose.
    if (results.holdout !== undefined) {
      await applyRecordHoldout(fold, runId, taskId, verdictStore, results.holdout.raw);
    }
    const env = await applyRecordReviews(fold, runId, taskId, verdictStore, results.reviews);
    return env.step;
  }
  throw new Error(`drive: --results given but stage '${stage}' spawns no agents`);
}

/**
 * Pump one task: fold results (if given), then run deterministic stages until a
 * spawn is needed or the task is terminal. See the module doc for the contract.
 */
export async function pumpTask(
  deps: PumpDeps,
  runId: string,
  taskId: string,
  results?: DriveResults,
): Promise<DriveEnvelope> {
  // 1. Quota gate first — a breach persists the checkpoint and stops cleanly.
  const stop = await applyQuotaGate(deps, runId);
  if (stop !== null) {
    return {
      kind: "quota-blocked",
      run_id: runId,
      task_id: taskId,
      scope: stop.scope,
      reason: stop.reason,
      ...(stop.resets_at_epoch !== undefined ? { resets_at_epoch: stop.resets_at_epoch } : {}),
    };
  }

  // 2. Resume at the persisted cursor.
  let run = await deps.state.read(runId);
  let task = requireTask(run, taskId);
  if (isTerminalTaskStatus(task.status)) {
    return { kind: "terminal", run_id: runId, task_id: taskId, outcome: terminalOutcome(task) };
  }
  let stage: TaskStage = task.stage ?? "preflight";

  // 3. Fold the previous spawn's results (validated against the cursor's stage).
  if (results !== undefined) {
    const step = await foldResults(deps, runId, taskId, stage, results);
    if (step.done) {
      return { kind: "terminal", run_id: runId, task_id: taskId, outcome: step.outcome };
    }
    stage = step.stage;
  }

  // 4. The deterministic pump loop (loop.ts act() semantics, spawn inverted).
  const handlers = makeStageHandlers(deps);
  for (;;) {
    await markInFlight(deps, runId, taskId, stage);
    run = await deps.state.read(runId);
    task = requireTask(run, taskId);
    const ctx: StageContext = { run, task, attempt: task.escalation_rung + 1 };

    const result: StageResult =
      stage === "ship" ? await shipTask(deps, ctx) : await runStage(stage, ctx, handlers);

    switch (result.kind) {
      case "advance": {
        stage = result.to;
        continue;
      }
      case "spawn-agents": {
        const expects: DriveExpects = stage === "verify" ? "reviews" : "producer-status";
        const worktree = taskWorktreePath(deps.dataDir, runId, taskId);
        const sidecar = stage === "verify" ? await holdoutSidecar(deps, runId, taskId) : undefined;
        return {
          kind: "spawn",
          run_id: runId,
          task_id: taskId,
          stage,
          manifest: result.manifest,
          ...(sidecar !== undefined ? { sidecar } : {}),
          expects,
          worktree,
        };
      }
      case "task-terminal": {
        if (result.outcome.outcome === "done") {
          const step = await completeTask(deps, runId, taskId);
          if (!step.done) throw new Error("pump: completeTask returned non-terminal step");
          return { kind: "terminal", run_id: runId, task_id: taskId, outcome: step.outcome };
        }
        const step = await dropStep(
          deps,
          runId,
          taskId,
          result.outcome.failure_class,
          result.outcome.reason,
        );
        if (!step.done) throw new Error("pump: dropStep returned non-terminal step");
        return { kind: "terminal", run_id: runId, task_id: taskId, outcome: step.outcome };
      }
      case "wait-retry": {
        if (result.stage === "ship") {
          // Live-merge refusal → bounded re-sync through exec (persisted budget).
          run = await deps.state.read(runId);
          task = requireTask(run, taskId);
          const resyncs = task.merge_resyncs + 1;
          if (resyncs > MERGE_RESYNC_CAP) {
            const step = await dropStep(
              deps,
              runId,
              taskId,
              "blocked-environmental",
              `serial-merge re-sync budget (${MERGE_RESYNC_CAP}) exhausted: ${result.reason}`,
            );
            if (!step.done) throw new Error("pump: dropStep returned non-terminal step");
            return { kind: "terminal", run_id: runId, task_id: taskId, outcome: step.outcome };
          }
          await deps.state.updateTask(runId, taskId, (t) => ({ ...t, merge_resyncs: resyncs }));
          stage = "exec";
          continue;
        }
        // verify floor blocked on a crash-resume replay → same classify path as the fold.
        const step = await escalateOrDrop(
          deps,
          runId,
          taskId,
          classifyFailure({ kind: "floor-blocked", reason: result.reason }),
          "exec",
        );
        if (step.done) {
          return { kind: "terminal", run_id: runId, task_id: taskId, outcome: step.outcome };
        }
        stage = step.stage;
        continue;
      }
      case "graceful-stop":
      case "finalize-terminal":
        throw new Error(`pump: run-scope result '${result.kind}' surfaced at task scope`);
      default:
        return assertNever(result);
    }
  }
}
