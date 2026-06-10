/**
 * Fold cores — shared between the CLI single-step subcommands and the forthcoming
 * per-task pump.  These are the DETERMINISTIC, state-mutating functions that fold
 * out-of-band agent results into run state; they live here (driver/) so the pump can
 * import them directly without creating a cli→driver dependency inversion.
 *
 * Moved verbatim from:
 *   - src/cli/transition.ts      → TransitionEnvelope, persistStepCursor, readJsonInput
 *   - src/cli/subcommands/record-producer.ts → producerStageInfo, applyRecordProducer
 *   - src/cli/subcommands/record-holdout.ts  → RecordHoldoutInput, RecordHoldoutEnvelope,
 *                                               applyRecordHoldout
 *   - src/cli/subcommands/record-reviews.ts  → VerifierVerdictInput, ReviewerVerifications,
 *                                               RecordReviewsInput, RecordReviewsEnvelope,
 *                                               buildWorktreeSource, makeReplayRunnerFactory,
 *                                               applyRecordReviews, REPLAY_IDENTITY
 *
 * Signature adjustments from the move (only):
 *   - applyRecordReviews: was (deps: CliDeps, verdictStore, taskId, input);
 *     now (deps: FoldDeps, runId, taskId, verdictStore, input).  The body reads the
 *     task via deps.state.read(runId) instead of deps.run.
 *   - applyRecordHoldout: was (deps: CliDeps, verdictStore, taskId, raw);
 *     now (deps: FoldDeps, runId, taskId, verdictStore, raw).  The body reads runId
 *     from the explicit parameter instead of deps.run.run_id.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseJson } from "../shared/json.js";
import {
  markInFlight,
  escalateOrDrop,
  applyProducerOutcome,
  type TaskStep,
} from "./transitions.js";
import { taskWorktreePath } from "./paths.js";
import { classifyFailure, ESCALATION_CAP, parseProducerStatus } from "../producer/index.js";
import { nextStage, stageToInFlightStatus } from "../types/index.js";
import { GateRunner, type GateContext } from "../verifier/deterministic/index.js";
import {
  runPanel,
  parseRawReview,
  type RawReview,
  type SourceReader,
  type FindingVerifierRunner,
} from "../verifier/judgment/index.js";
import {
  checkHoldout,
  holdoutEvidence,
  parseHoldoutVerdicts,
  type HoldoutVerdict,
  type HoldoutVerdictStore,
  type HoldoutCheckResult,
} from "../verifier/holdout/index.js";
import { createLogger, UsageError } from "../shared/index.js";
import type {
  GateEvidence,
  GateVerdict,
  ReviewerResult,
  ProducerRole,
  TaskStage,
} from "../types/index.js";
import type { HandlerDeps } from "./types.js";
import type { StateManager } from "./deps.js";

const log = createLogger("fold");

// ---------------------------------------------------------------------------
// FoldDeps
// ---------------------------------------------------------------------------

/**
 * What a fold needs: the reporter bundle ({@link HandlerDeps}) + the sanctioned
 * state write path.  A strict subset of {@link import("./types.js").DriveDeps}.
 */
export interface FoldDeps extends HandlerDeps {
  readonly state: StateManager;
}

// ---------------------------------------------------------------------------
// TransitionEnvelope + persistStepCursor + readJsonInput  (from transition.ts)
// ---------------------------------------------------------------------------

/** The single JSON document the state-write subcommands emit — the next loop step. */
export interface TransitionEnvelope {
  readonly run_id: string;
  readonly task_id: string;
  /** Keep going at `step.stage`, or stop with `step.outcome` (done/dropped). */
  readonly step: TaskStep;
}

/**
 * After a transition, persist the in-flight CURSOR for a non-terminal step so the
 * persisted task status tracks the resume point (the loop does this implicitly at the
 * top of each iteration; the single-step CLI must do it explicitly). A terminal step
 * (`done`/`dropped`) already wrote its own status — nothing to mark.
 */
export async function persistStepCursor(
  deps: { readonly state: StateManager },
  runId: string,
  taskId: string,
  step: TaskStep,
): Promise<void> {
  if (!step.done) {
    await markInFlight(deps, runId, taskId, step.stage);
  }
}

/** Read + parse a JSON input file (the orchestrator's collected agent output). */
export async function readJsonInput<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return parseJson<T>(raw, path);
}

// ---------------------------------------------------------------------------
// applyRecordProducer  (from record-producer.ts)
// ---------------------------------------------------------------------------

/** The producer role + resume target for a producer stage (LOUD on a non-producer stage). */
function producerStageInfo(stage: string): {
  role: ProducerRole;
  stage: TaskStage;
  after: TaskStage;
} {
  if (stage === "tests") return { role: "test-writer", stage: "tests", after: "exec" };
  if (stage === "exec") return { role: "executor", stage: "exec", after: "verify" };
  throw new UsageError(`stage must be a producer stage (tests | exec), got '${stage}'`);
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

// ---------------------------------------------------------------------------
// applyRecordHoldout  (from record-holdout.ts)
// ---------------------------------------------------------------------------

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
  deps: FoldDeps,
  runId: string,
  taskId: string,
  verdictStore: HoldoutVerdictStore,
  raw: string,
): Promise<RecordHoldoutEnvelope> {
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

// ---------------------------------------------------------------------------
// applyRecordReviews  (from record-reviews.ts)
// ---------------------------------------------------------------------------

/** A fixed, reviewer-independent identity for the replay verifier (D27 independence). */
export const REPLAY_IDENTITY = "orchestrator-replay";

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
export async function buildWorktreeSource(
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
export function makeReplayRunnerFactory(
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
  deps: FoldDeps,
  runId: string,
  taskId: string,
  verdictStore: HoldoutVerdictStore,
  input: RecordReviewsInput,
): Promise<RecordReviewsEnvelope> {
  const run = await deps.state.read(runId);
  const task = run.tasks[taskId];
  if (task === undefined) {
    throw new Error(`record-reviews: run '${runId}' has no task '${taskId}'`);
  }
  const worktree = taskWorktreePath(deps.dataDir, runId, taskId);

  // 1. parse reviews + build the worktree source and the replay verifier factory
  //    (BEFORE the expensive GateRunner re-run — a malformed review item must fail
  //    fast rather than burning a full deterministic gate sweep first).
  const reviews = input.reviews.map(parseRawReview);
  const source = await buildWorktreeSource(worktree, reviews);
  const makeRunner = makeReplayRunnerFactory(input);

  // 2. deterministic gates (re-run, never read back — Δ V).
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

  // 3. holdout gate evidence — RE-DERIVED from the verdicts record-holdout persisted
  //    (derive-don't-store exception). A withheld key with no persisted verdicts is an
  //    orchestration error (record-holdout must run first) — LOUD, never a silent pass.
  if (await deps.holdout.has(runId, taskId)) {
    const record = await deps.holdout.get(runId, taskId);
    const verdicts = await verdictStore.get(runId, taskId);
    gateEvidence.push(
      holdoutEvidence(checkHoldout(record, verdicts, deps.config.quality.holdoutPassRate)),
    );
  }

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

  // 5+6. Act on the derived result through the SHARED ladder.
  //
  // Crash-safety invariant (fail-closed): reviewers are persisted ONLY on the
  // advance branch, in the SAME updateTask call that stamps the cursor. On the
  // escalate/drop branch we do NOT persist reviewers — escalateOrDrop owns its
  // own state write. A crash before the single advance-write means a no-results
  // re-invoke at verify finds no reviewers → fresh panel spawn (fail-closed);
  // holdout evidence cannot be bypassed by replaying without holdout results.

  let step: TaskStep;
  if (panel.result.kind === "advance") {
    // Persist reviewers + stamp the cursor in ONE locked write (advance branch only).
    // stageToInFlightStatus is the same mapping markInFlight would apply.
    const nextStageVal = panel.result.to;
    const nextStatus = stageToInFlightStatus(nextStageVal);
    await deps.state.updateTask(runId, taskId, (t) => ({
      ...t,
      reviewers: [...panel.reviewerResults],
      stage: nextStageVal,
      status: nextStatus,
    }));
    step = { done: false, stage: nextStageVal };
  } else if (panel.result.kind === "wait-retry") {
    // escalateOrDrop does its own state write; do NOT persist reviewers here.
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
