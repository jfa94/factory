/**
 * `factory record-producer --run <id> --task <id> --stage <tests|exec> --status <line>`
 * — fold a completed producer spawn back into state.
 *
 * The orchestrator spawned the producer (test-writer at `tests`, executor at `exec`)
 * out-of-band; this folds the agent's terminal STATUS line into the task via the
 * SHARED transition logic (so the CLI path and the in-process loop apply the IDENTICAL
 * ladder — Δ D):
 *   - {@link parseProducerStatus} maps the raw line → a closed {@link ProducerOutcome}.
 *   - {@link applyProducerOutcome} records `producer_role` + advances on `done`, else
 *     classifies the failure → escalate-or-drop (resume at the SAME producer stage,
 *     bumping the rung; an exhausted ladder is a `capability-budget` drop).
 * The resulting non-terminal step's in-flight cursor is then persisted, and the step
 * is emitted as a {@link TransitionEnvelope}.
 */
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError, UsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { applyProducerOutcome } from "../../driver/index.js";
import { parseProducerStatus } from "../../producer/index.js";
import { StateManager } from "../../core/state/index.js";
import { nextStage } from "../../types/index.js";
import type { ProducerRole, TaskStage } from "../../types/index.js";
import { persistStepCursor, type TransitionEnvelope } from "../transition.js";
import type { Subcommand } from "../main.js";

const HELP = `factory record-producer — fold a producer spawn outcome into state

Usage:
  factory record-producer --run <id> --task <id> --stage <tests|exec> --status <line>

--status is the producer agent's terminal STATUS line (e.g. "STATUS: DONE",
"STATUS: BLOCKED — escalate", "STATUS: NEEDS_CONTEXT").

Emits ONE JSON envelope: { run_id, task_id, step }. On done the step advances to the
next stage; a classified failure escalates the rung (resume at the same stage) or
drops (loud, classified) when the ladder is exhausted.`;

/** The producer role + resume target for a producer stage (LOUD on a non-producer stage). */
function producerStageInfo(stage: string): {
  role: ProducerRole;
  stage: TaskStage;
  after: TaskStage;
} {
  if (stage === "tests") return { role: "test-writer", stage: "tests", after: "exec" };
  if (stage === "exec") return { role: "executor", stage: "exec", after: "verify" };
  throw new UsageError(`--stage must be a producer stage (tests | exec), got '${stage}'`);
}

/** Fold the producer status into state and return the next-step envelope. */
export async function applyRecordProducer(
  state: StateManager,
  runId: string,
  taskId: string,
  stage: string,
  statusLine: string,
): Promise<TransitionEnvelope> {
  const info = producerStageInfo(stage);
  // Defensive: nextStage(stage) must equal the hardcoded resume target — keeps the
  // mapping honest if the stage order ever changes (LOUD on drift, never silent).
  if (nextStage(info.stage) !== info.after) {
    throw new Error(
      `record-producer: stage order drift — nextStage('${info.stage}') !== '${info.after}'`,
    );
  }
  const run = await state.read(runId);
  if (run.tasks[taskId] === undefined) {
    throw new Error(`record-producer: run '${runId}' has no task '${taskId}'`);
  }
  const outcome = parseProducerStatus(statusLine);
  const step = await applyProducerOutcome(
    { state },
    runId,
    taskId,
    { role: info.role, stage: info.stage, stageAfter: info.after },
    outcome,
  );
  await persistStepCursor({ state }, runId, taskId, step);
  return { run_id: runId, task_id: taskId, step };
}

async function run(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: [] });
  if (args.flag("help") === true) {
    emitLine(HELP);
    return EXIT.OK;
  }

  const runId = args.requireFlag("run");
  const taskId = args.requireFlag("task");
  const stage = args.requireFlag("stage");
  const statusLine = args.requireFlag("status");

  const envelope = await applyRecordProducer(new StateManager(), runId, taskId, stage, statusLine);
  emitJson(envelope);
  return EXIT.OK;
}

export const recordProducerCommand: Subcommand = {
  describe: "Fold a producer spawn outcome into state (ladder + classify) and emit the step",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`record-producer: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
