/**
 * `factory record-holdout --run <id> --task <id> --input <path>` — fold the out-of-band
 * holdout-validator's output (Δ Y / Decision 5).
 *
 * The holdout-validator is a SIDECAR spawn (it is not in the closed panel SpawnRole
 * set), surfaced by `factory run-task --stage verify`. The orchestrator runs it, then
 * hands its raw output here. This subcommand:
 *   1. parses the raw output → {@link HoldoutVerdict}s (FAIL-CLOSED: an unparseable
 *      output becomes `[]`, so every withheld criterion scores as a FAIL — never a
 *      silent pass),
 *   2. PERSISTS the raw verdicts ({@link HoldoutVerdictStore}) so the later
 *      `record-reviews` fold re-derives the holdout gate evidence from them (the
 *      sanctioned derive-don't-store exception — the verdicts come from an agent), and
 *   3. emits the DERIVED holdout {@link import("../../types/index.js").GateEvidence}
 *      + the scored detail for the orchestrator's audit.
 *
 * The input file is `{ "raw": "<validator output>" }`. It is a LOUD error to call this
 * for a task with no withheld answer key (a degenerate split persists none) — the
 * orchestrator only calls it when `run-task --stage verify` surfaced a holdout sidecar.
 */
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { loadCliDeps, type CliDeps } from "../wiring.js";
import { readJsonInput } from "../transition.js";
import {
  parseHoldoutVerdicts,
  checkHoldout,
  holdoutEvidence,
  FsHoldoutVerdictStore,
  type HoldoutVerdict,
  type HoldoutVerdictStore,
  type HoldoutCheckResult,
} from "../../verifier/holdout/index.js";
import { createLogger } from "../../shared/index.js";
import type { GateEvidence } from "../../types/index.js";
import type { Subcommand } from "../main.js";

const log = createLogger("record-holdout");

const HELP = `factory record-holdout — fold the holdout-validator output into the floor

Usage:
  factory record-holdout --run <id> --task <id> --input <path>

--input is a JSON file: { "raw": "<holdout-validator agent output>" }.

Persists the parsed verdicts (read back by record-reviews) and emits ONE JSON
envelope: { run_id, task_id, evidence, check }. Unparseable validator output fails
CLOSED (every withheld criterion scores as a failure).`;

/** The input file shape: the raw holdout-validator agent output. */
export interface RecordHoldoutInput {
  readonly raw: string;
}

/** The JSON document `record-holdout` emits. */
export interface RecordHoldoutEnvelope {
  readonly run_id: string;
  readonly task_id: string;
  /** The DERIVED holdout gate evidence (folded into the floor by record-reviews). */
  readonly evidence: GateEvidence;
  /** The scored detail (audit). */
  readonly check: HoldoutCheckResult;
}

/**
 * Parse the validator output FAIL-CLOSED: an unrecoverable parse is `[]` (every
 * withheld criterion then scores as a FAIL), mirroring the runner contract in
 * validate.ts — never throws a pass through on garbage.
 */
function parseVerdictsFailClosed(raw: string): readonly HoldoutVerdict[] {
  try {
    return parseHoldoutVerdicts(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`holdout validator output unparseable — failing closed (0 satisfied): ${detail}`);
    return [];
  }
}

/** Fold the holdout-validator output: persist raw verdicts + emit derived evidence. */
export async function applyRecordHoldout(
  deps: CliDeps,
  verdictStore: HoldoutVerdictStore,
  taskId: string,
  raw: string,
): Promise<RecordHoldoutEnvelope> {
  const runId = deps.run.run_id;
  if (!(await deps.holdout.has(runId, taskId))) {
    throw new Error(
      `record-holdout: task '${taskId}' has no withheld answer key — nothing to validate ` +
        `(record-holdout must only be called when run-task surfaced a holdout sidecar)`,
    );
  }
  const record = await deps.holdout.get(runId, taskId);
  const verdicts = parseVerdictsFailClosed(raw);
  await verdictStore.put(runId, taskId, verdicts);

  const check = checkHoldout(record, verdicts, deps.config.quality.holdoutPassRate);
  return { run_id: runId, task_id: taskId, evidence: holdoutEvidence(check), check };
}

async function run(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: [] });
  if (args.flag("help") === true) {
    emitLine(HELP);
    return EXIT.OK;
  }

  const runId = args.requireFlag("run");
  const taskId = args.requireFlag("task");
  const inputPath = args.requireFlag("input");

  const deps = await loadCliDeps({ runId });
  const input = await readJsonInput<RecordHoldoutInput>(inputPath);
  const verdictStore = new FsHoldoutVerdictStore(deps.dataDir);

  const envelope = await applyRecordHoldout(deps, verdictStore, taskId, input.raw);
  emitJson(envelope);
  return EXIT.OK;
}

export const recordHoldoutCommand: Subcommand = {
  describe: "Fold the holdout-validator output (persist verdicts, emit derived evidence)",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`record-holdout: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
