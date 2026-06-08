/**
 * `factory advance --run <id> --task <id> --to <stage>` — the CURSOR writer.
 *
 * After a report stage emits `{kind:"advance", to}` (e.g. preflight→tests, or a
 * tdd_exempt tests→exec), the orchestrator persists the move with this subcommand:
 * it stamps the in-flight status for `<stage>` (and `started_at` on first entry) via
 * the shared {@link markInFlight}, then emits the resulting non-terminal
 * {@link TransitionEnvelope} step. It writes ONLY the cursor — no domain transition,
 * no agent fold (those are `record-producer`/`record-reviews`).
 */
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError, UsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { markInFlight } from "../../driver/index.js";
import { StateManager } from "../../core/state/index.js";
import { TASK_STAGE_ORDER } from "../../types/index.js";
import type { TaskStage } from "../../types/index.js";
import type { TransitionEnvelope } from "../transition.js";
import type { Subcommand } from "../main.js";

const HELP = `factory advance — persist the in-flight cursor for the next stage

Usage:
  factory advance --run <id> --task <id> --to <stage>

Stages: ${TASK_STAGE_ORDER.join(" | ")}

Emits ONE JSON envelope: { run_id, task_id, step: { done:false, stage } }.
Use after a run-task report stage returns { kind:"advance", to }. This writes
only the cursor (status + started_at); producer/review folds use record-*.`;

/** Validate the `--to` flag against the closed task-stage set. */
function parseStage(raw: string): TaskStage {
  if ((TASK_STAGE_ORDER as readonly string[]).includes(raw)) {
    return raw as TaskStage;
  }
  throw new UsageError(`unknown --to '${raw}' (expected one of ${TASK_STAGE_ORDER.join(", ")})`);
}

/** Persist the cursor for `taskId` at `to` and return the next-step envelope. */
export async function applyAdvance(
  state: StateManager,
  runId: string,
  taskId: string,
  to: TaskStage,
): Promise<TransitionEnvelope> {
  const run = await state.read(runId);
  if (run.tasks[taskId] === undefined) {
    throw new Error(`advance: run '${runId}' has no task '${taskId}'`);
  }
  await markInFlight({ state }, runId, taskId, to);
  return { run_id: runId, task_id: taskId, step: { done: false, stage: to } };
}

async function run(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: [] });
  if (args.flag("help") === true) {
    emitLine(HELP);
    return EXIT.OK;
  }

  const runId = args.requireFlag("run");
  const taskId = args.requireFlag("task");
  const to = parseStage(args.requireFlag("to"));

  const envelope = await applyAdvance(new StateManager(), runId, taskId, to);
  emitJson(envelope);
  return EXIT.OK;
}

export const advanceCommand: Subcommand = {
  describe: "Persist the in-flight cursor for the next stage and emit the step",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`advance: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
