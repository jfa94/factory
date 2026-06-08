/**
 * `factory drop --run <id> --task <id> --class <failure-class> --reason <text>` — the
 * explicit, classified LOUD drop (Δ D / Decision 22).
 *
 * Most drops are derived inside `record-producer`/`record-reviews` (a classified
 * producer failure, an exhausted ladder, a blocked floor). This subcommand is the
 * orchestrator's MANUAL drop path — e.g. a dependency the orchestrator itself judged
 * unsatisfiable, or an operator decision — applied through the SAME shared
 * {@link dropStep} so a drop is always classified + reason'd, never silent.
 */
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError, UsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { dropStep } from "../../driver/index.js";
import { StateManager } from "../../core/state/index.js";
import { FailureClassEnum } from "../../types/index.js";
import type { FailureClass } from "../../types/index.js";
import type { TransitionEnvelope } from "../transition.js";
import type { Subcommand } from "../main.js";

const HELP = `factory drop — apply a classified LOUD drop to a task

Usage:
  factory drop --run <id> --task <id> --class <failure-class> --reason <text>

Failure classes: ${FailureClassEnum.options.join(" | ")}

Emits ONE JSON envelope:
  { run_id, task_id, step: { done:true, outcome:{ outcome:"dropped", failure_class, reason } } }`;

/** Validate the `--class` flag against the closed failure-class enum. */
function parseFailureClass(raw: string): FailureClass {
  const parsed = FailureClassEnum.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `unknown --class '${raw}' (expected one of ${FailureClassEnum.options.join(", ")})`,
    );
  }
  return parsed.data;
}

/** Apply the classified drop and return the terminal-step envelope. */
export async function applyDrop(
  state: StateManager,
  runId: string,
  taskId: string,
  failureClass: FailureClass,
  reason: string,
): Promise<TransitionEnvelope> {
  const run = await state.read(runId);
  if (run.tasks[taskId] === undefined) {
    throw new Error(`drop: run '${runId}' has no task '${taskId}'`);
  }
  const step = await dropStep({ state }, runId, taskId, failureClass, reason);
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
  const failureClass = parseFailureClass(args.requireFlag("class"));
  const reason = args.requireFlag("reason");

  const envelope = await applyDrop(new StateManager(), runId, taskId, failureClass, reason);
  emitJson(envelope);
  return EXIT.OK;
}

export const dropCommand: Subcommand = {
  describe: "Apply a classified LOUD drop to a task and emit the terminal step",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`drop: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
