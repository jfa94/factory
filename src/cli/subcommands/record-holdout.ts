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
import { loadCliDeps } from "../wiring.js";
import { applyRecordHoldout, readJsonInput, type RecordHoldoutInput } from "../../driver/fold.js";
import { FsHoldoutVerdictStore } from "../../verifier/holdout/index.js";
import type { Subcommand } from "../main.js";

// Re-exports so existing consumers don't break until Phase 2.
/** @deprecated Implementation in `../../driver/fold.js`; shell deleted in Phase 2. */
export { applyRecordHoldout } from "../../driver/fold.js";
/** @deprecated Implementation in `../../driver/fold.js`; shell deleted in Phase 2. */
export type { RecordHoldoutInput, RecordHoldoutEnvelope } from "../../driver/fold.js";
/** @deprecated Implementation in `../../verifier/holdout/index.js`; shell deleted in Phase 2. */
export type { HoldoutVerdictStore } from "../../verifier/holdout/index.js";

const HELP = `factory record-holdout — fold the holdout-validator output into the floor

Usage:
  factory record-holdout --run <id> --task <id> --input <path>

--input is a JSON file: { "raw": "<holdout-validator agent output>" }.

Persists the parsed verdicts (read back by record-reviews) and emits ONE JSON
envelope: { run_id, task_id, evidence, check }. Unparseable validator output fails
CLOSED (every withheld criterion scores as a failure).`;

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

  const envelope = await applyRecordHoldout(deps, runId, taskId, verdictStore, input.raw);
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
