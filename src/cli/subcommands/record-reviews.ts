/**
 * `factory record-reviews --run <id> --task <id> --input <path>` — fold the panel +
 * verify-then-fix verdicts into the floor (Decision 26/27, Δ K/T/U/V).
 *
 * This is the CLI mirror of the in-process loop's `runVerify` act-on-result. The
 * orchestrator spawned the 6-reviewer risk-invariant panel AND, per reviewer, an
 * INDEPENDENT finding-verifier; it collected the raw reviews + per-finding verdicts and
 * hands them here. The fold is fully DETERMINISTIC (no spawn):
 *   1. RE-RUN the deterministic gates over the worktree (derive-don't-store — Δ V).
 *   2. Fold the holdout gate evidence by RE-DERIVING it from the verdicts
 *      `record-holdout` persisted (the sanctioned derive-don't-store exception).
 *   3. Parse the raw reviews (LOUD on malformed), citation-verify them against the
 *      worktree source, and confirm each surviving blocker through a REPLAY
 *      finding-verifier — a {@link FindingVerifierRunner} that returns the
 *      orchestrator's pre-recorded verdict instead of spawning (independence is
 *      preserved: its identity differs from every reviewer; a missing verdict for a
 *      kept finding FAILS CLOSED via an `error` outcome).
 *   4. DERIVE the floor via {@link runPanel}; persist the per-reviewer results; act on
 *      the result through the SHARED ladder (advance→ship, or classify floor-blocked →
 *      escalate-or-drop resuming at exec).
 *
 * The input file is `{ reviews:[…raw…], verifications:[{reviewer, verdicts:[…]}],
 * crossVendorAbsent?:{reason} }`.
 */
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { loadCliDeps } from "../wiring.js";
import { applyRecordReviews, readJsonInput, type RecordReviewsInput } from "../../driver/fold.js";
import { FsHoldoutVerdictStore } from "../../verifier/holdout/index.js";
import type { Subcommand } from "../main.js";

// Re-exports so existing consumers don't break until Phase 2.
/** @deprecated Implementation in `../../driver/fold.js`; shell deleted in Phase 2. */
export { applyRecordReviews } from "../../driver/fold.js";
/** @deprecated Implementation in `../../driver/fold.js`; shell deleted in Phase 2. */
export type {
  VerifierVerdictInput,
  ReviewerVerifications,
  RecordReviewsInput,
  RecordReviewsEnvelope,
} from "../../driver/fold.js";

const HELP = `factory record-reviews — fold the panel + verify-then-fix into the floor

Usage:
  factory record-reviews --run <id> --task <id> --input <path>

--input is a JSON file:
  {
    "reviews": [ <raw reviewer payload>, ... ],
    "verifications": [ { "reviewer": "<role>",
                         "verdicts": [ { "file","line","holds","note" }, ... ] }, ... ],
    "crossVendorAbsent": { "reason": "..." }   // optional (Δ U)
  }

Re-runs the gates, re-derives the persisted holdout evidence, citation-verifies +
confirms each blocker via the recorded verdicts, derives the floor, persists the
reviewers, and emits ONE JSON envelope: { run_id, task_id, step, reviewers, floor }.`;

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
  const input = await readJsonInput<RecordReviewsInput>(inputPath);
  const verdictStore = new FsHoldoutVerdictStore(deps.dataDir);

  const envelope = await applyRecordReviews(deps, runId, taskId, verdictStore, input);
  emitJson(envelope);
  return EXIT.OK;
}

export const recordReviewsCommand: Subcommand = {
  describe: "Fold the panel + verify-then-fix verdicts into the floor and emit the step",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`record-reviews: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
