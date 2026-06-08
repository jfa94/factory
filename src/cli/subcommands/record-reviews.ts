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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { loadCliDeps, type CliDeps } from "../wiring.js";
import { persistStepCursor, readJsonInput, type TransitionEnvelope } from "../transition.js";
import {
  markInFlight,
  escalateOrDrop,
  taskWorktreePath,
  type TaskStep,
} from "../../driver/index.js";
import { classifyFailure, ESCALATION_CAP } from "../../producer/index.js";
import { GateRunner, type GateContext } from "../../verifier/deterministic/index.js";
import {
  runPanel,
  parseRawReview,
  type RawReview,
  type SourceReader,
  type FindingVerifierRunner,
} from "../../verifier/judgment/index.js";
import {
  checkHoldout,
  holdoutEvidence,
  FsHoldoutVerdictStore,
  type HoldoutVerdictStore,
} from "../../verifier/holdout/index.js";
import type { GateEvidence, GateVerdict, ReviewerResult } from "../../types/index.js";
import type { Subcommand } from "../main.js";

/** A fixed, reviewer-independent identity for the replay verifier (D27 independence). */
const REPLAY_IDENTITY = "orchestrator-replay";

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

/** One pre-recorded finding-verifier verdict (orchestrator-collected, out-of-band). */
export interface VerifierVerdictInput {
  readonly file: string;
  readonly line: number;
  /** True iff the finding holds against the code (confirmed). */
  readonly holds: boolean;
  readonly note: string;
}

/** A reviewer's pre-recorded finding-verifier verdicts. */
export interface ReviewerVerifications {
  readonly reviewer: string;
  readonly verdicts: readonly VerifierVerdictInput[];
}

/** The input file shape (orchestrator-collected panel + verify-then-fix output). */
export interface RecordReviewsInput {
  /** The raw reviewer payloads (one per panel reviewer) — parsed LOUD. */
  readonly reviews: readonly unknown[];
  /** Per-reviewer pre-recorded finding-verifier verdicts (the replay source). */
  readonly verifications: readonly ReviewerVerifications[];
  /** Δ U — a recorded second-vendor absence (surfaced loudly by runPanel). */
  readonly crossVendorAbsent?: { readonly reason: string };
}

/** The JSON document `record-reviews` emits. */
export interface RecordReviewsEnvelope extends TransitionEnvelope {
  /** The per-reviewer results this round derived (audit; state may clear them on retry). */
  readonly reviewers: readonly ReviewerResult[];
  /** The DERIVED floor verdict (never stored; recomputed here). */
  readonly floor: GateVerdict;
}

/**
 * Build a {@link SourceReader} over the task worktree for citation-verify: async-load
 * every cited file ONCE into a map, then serve `readLines` synchronously (a missing
 * file → `null`, so its citations are unverifiable and dropped).
 */
async function buildWorktreeSource(
  worktree: string,
  reviews: readonly RawReview[],
): Promise<SourceReader> {
  const files = new Set<string>();
  for (const review of reviews) {
    for (const finding of review.findings) {
      if (finding.file !== undefined) files.add(finding.file);
    }
  }
  const lines = new Map<string, readonly string[] | null>();
  for (const file of files) {
    try {
      const text = await readFile(join(worktree, file), "utf8");
      lines.set(file, text.split("\n"));
    } catch {
      lines.set(file, null);
    }
  }
  return { readLines: (file) => lines.get(file) ?? null };
}

/**
 * Build the REPLAY {@link FindingVerifierRunner} factory: for each reviewer, a runner
 * whose `confirm` returns the orchestrator's pre-recorded verdict for that finding
 * (matched by `file:line`, FIFO among duplicates) instead of spawning. A kept finding
 * with NO recorded verdict REJECTS — `confirmBlocker` turns that into a LOUD `error`
 * (fail-closed: the floor blocks, never a silent pass).
 */
function makeReplayRunnerFactory(
  input: RecordReviewsInput,
): (review: RawReview) => FindingVerifierRunner {
  const byReviewer = new Map<string, readonly VerifierVerdictInput[]>();
  for (const v of input.verifications) byReviewer.set(v.reviewer, v.verdicts);

  return (review) => {
    // Fresh shiftable queues per call so repeated factory calls never share state.
    const queues = new Map<string, VerifierVerdictInput[]>();
    for (const v of byReviewer.get(review.reviewer) ?? []) {
      const key = `${v.file}:${v.line}`;
      const arr = queues.get(key) ?? [];
      arr.push(v);
      queues.set(key, arr);
    }
    return {
      identity: REPLAY_IDENTITY,
      confirm(finding) {
        const key = `${finding.file}:${finding.line}`;
        const next = queues.get(key)?.shift();
        if (next === undefined) {
          return Promise.reject(
            new Error(
              `record-reviews: no pre-recorded finding-verifier verdict for reviewer ` +
                `'${review.reviewer}' finding at ${key} — every citation-verified blocking ` +
                `finding must carry an orchestrator-collected verdict`,
            ),
          );
        }
        return Promise.resolve({ holds: next.holds, note: next.note });
      },
    };
  };
}

/**
 * Fold the panel + verify-then-fix verdicts into the floor and return the next-step
 * envelope. `verdictStore` is the holdout-verdict source `record-holdout` persisted.
 */
export async function applyRecordReviews(
  deps: CliDeps,
  verdictStore: HoldoutVerdictStore,
  taskId: string,
  input: RecordReviewsInput,
): Promise<RecordReviewsEnvelope> {
  const runId = deps.run.run_id;
  const task = deps.run.tasks[taskId];
  if (task === undefined) {
    throw new Error(`record-reviews: run '${runId}' has no task '${taskId}'`);
  }
  const worktree = taskWorktreePath(deps.dataDir, runId, taskId);

  // 1. deterministic gates (re-run, never read back — Δ V).
  const gateCtx: GateContext = {
    runId,
    taskId,
    worktree,
    baseRef: deps.config.git.stagingBranch,
    config: deps.config,
    tools: deps.tools,
  };
  const gate = await new GateRunner().run(gateCtx);
  const gateEvidence: GateEvidence[] = [...gate.evidence];

  // 2. holdout gate evidence — RE-DERIVED from the verdicts record-holdout persisted
  //    (derive-don't-store exception). A withheld key with no persisted verdicts is an
  //    orchestration error (record-holdout must run first) — LOUD, never a silent pass.
  if (await deps.holdout.has(runId, taskId)) {
    const record = await deps.holdout.get(runId, taskId);
    const verdicts = await verdictStore.get(runId, taskId);
    gateEvidence.push(
      holdoutEvidence(checkHoldout(record, verdicts, deps.config.quality.holdoutPassRate)),
    );
  }

  // 3. parse reviews + build the worktree source and the replay verifier factory.
  const reviews = input.reviews.map(parseRawReview);
  const source = await buildWorktreeSource(worktree, reviews);
  const makeRunner = makeReplayRunnerFactory(input);

  // 4. derive the floor (citation-verify + replay-confirm + conjunctive floor).
  const panel = await runPanel({
    reviews,
    source,
    makeRunner,
    gateEvidence,
    stage: "verify",
    attempt: task.escalation_rung + 1,
    maxAttempts: ESCALATION_CAP + 1,
    ...(input.crossVendorAbsent !== undefined
      ? { crossVendor: { status: "absent", reason: input.crossVendorAbsent.reason } as const }
      : {}),
  });

  // 5. persist the per-reviewer results (coherent counts; never a stored verdict).
  await deps.state.updateTask(runId, taskId, (t) => ({
    ...t,
    reviewers: [...panel.reviewerResults],
  }));

  // 6. act on the derived result through the SHARED ladder.
  let step: TaskStep;
  if (panel.result.kind === "advance") {
    step = { done: false, stage: panel.result.to };
    await markInFlight(deps, runId, taskId, panel.result.to);
  } else if (panel.result.kind === "wait-retry") {
    step = await escalateOrDrop(
      deps,
      runId,
      taskId,
      classifyFailure({ kind: "floor-blocked", reason: panel.result.reason }),
      "exec",
    );
    await persistStepCursor(deps, runId, taskId, step);
  } else {
    throw new Error(`record-reviews: unexpected panel result kind '${panel.result.kind}'`);
  }

  return {
    run_id: runId,
    task_id: taskId,
    step,
    reviewers: panel.reviewerResults,
    floor: panel.floor,
  };
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
  const input = await readJsonInput<RecordReviewsInput>(inputPath);
  const verdictStore = new FsHoldoutVerdictStore(deps.dataDir);

  const envelope = await applyRecordReviews(deps, verdictStore, taskId, input);
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
