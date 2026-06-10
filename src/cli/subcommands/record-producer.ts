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
import { parseArgs, isUsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { StateManager } from "../../core/state/index.js";
import { applyRecordProducer } from "../../driver/fold.js";
import type { TransitionEnvelope } from "../../driver/fold.js";
import type { Subcommand } from "../main.js";

export { applyRecordProducer } from "../../driver/fold.js";
export type { TransitionEnvelope } from "../../driver/fold.js";

const HELP = `factory record-producer — fold a producer spawn outcome into state

Usage:
  factory record-producer --run <id> --task <id> --stage <tests|exec> --status <line>

--status is the producer agent's terminal STATUS line (e.g. "STATUS: DONE",
"STATUS: BLOCKED — escalate", "STATUS: NEEDS_CONTEXT").

Emits ONE JSON envelope: { run_id, task_id, step }. On done the step advances to the
next stage; a classified failure escalates the rung (resume at the same stage) or
drops (loud, classified) when the ladder is exhausted.`;

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

  const envelope: TransitionEnvelope = await applyRecordProducer(
    new StateManager(),
    runId,
    taskId,
    stage,
    statusLine,
  );
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
