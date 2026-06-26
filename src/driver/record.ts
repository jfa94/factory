/**
 * Record cores — the per-task coroutine's deterministic kernels.  These are the
 * DETERMINISTIC, state-mutating functions that record out-of-band agent results into
 * run state; they live here (driver/) so the coroutine imports them directly without a
 * cli→driver dependency inversion.
 *
 * Moved verbatim from the (since-deleted) CLI single-step subcommands:
 *   - src/cli/transition.ts      → TransitionEnvelope, persistStepCursor, readJsonInput
 *   - src/cli/subcommands/record-producer.ts → producerPhaseInfo, applyRecordProducer
 *   - src/cli/subcommands/record-holdout.ts  → RecordHoldoutInput, RecordHoldoutEnvelope,
 *                                               applyRecordHoldout
 *   - src/cli/subcommands/record-reviews.ts  → VerifierVerdictInput, ReviewerVerifications,
 *                                               RecordReviewsInput, RecordReviewsEnvelope,
 *                                               buildWorktreeSource, makeReplayRunnerFactory,
 *                                               applyRecordReviews, REPLAY_IDENTITY
 *
 * Signature adjustments from the move (only):
 *   - applyRecordReviews: was (deps: CliDeps, verdictStore, taskId, input);
 *     now (deps: RecordDeps, runId, taskId, verdictStore, input).  The body reads the
 *     task via deps.state.read(runId) instead of deps.run.
 *   - applyRecordHoldout: was (deps: CliDeps, verdictStore, taskId, raw);
 *     now (deps: RecordDeps, runId, taskId, verdictStore, raw).  The body reads runId
 *     from the explicit parameter instead of deps.run.run_id.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseJson } from "../shared/json.js";
import {
  markInFlight,
  escalateOrFail,
  applyProducerOutcome,
  type TaskStep,
} from "./transitions.js";
import { taskWorktreePath } from "./paths.js";
import { taskExemptReader } from "./exempt.js";
import { classifyFailure, ESCALATION_CAP, parseProducerStatus } from "../producer/index.js";
import { nextPhase, phaseToInFlightStatus } from "../types/index.js";
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
  TaskPhase,
} from "../types/index.js";
import type { HandlerDeps } from "./types.js";
import { resolveStagingBranch } from "./deps.js";
import type { StateManager } from "./deps.js";

const log = createLogger("record");

// ---------------------------------------------------------------------------
// RecordDeps
// ---------------------------------------------------------------------------

/**
 * What a record needs: the reporter bundle ({@link HandlerDeps}) + the sanctioned
 * state write path.  A strict subset of {@link import("./coroutine.js").CoroutineDeps}.
 */
export interface RecordDeps extends HandlerDeps {
  readonly state: StateManager;
}

// ---------------------------------------------------------------------------
// TransitionEnvelope + persistStepCursor + readJsonInput  (from transition.ts)
// ---------------------------------------------------------------------------

/** The envelope a record core emits — the next loop step for run/task. */
export interface TransitionEnvelope {
  readonly run_id: string;
  readonly task_id: string;
  /** Keep going at `step.phase`, or stop with `step.outcome` (done/failed). */
  readonly step: TaskStep;
}

/**
 * Persist the in-flight phase cursor for a non-terminal step so the persisted task
 * status tracks the resume point. A terminal step (`done`/`failed`) already wrote
 * its own status — nothing to mark. Used by the record paths in this module.
 */
async function persistStepCursor(
  deps: { readonly state: StateManager },
  runId: string,
  taskId: string,
  step: TaskStep,
): Promise<void> {
  if (!step.done) {
    await markInFlight(deps, runId, taskId, step.phase);
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

/** The producer role + resume target for a producer phase (LOUD on a non-producer phase). */
function producerPhaseInfo(phase: string): {
  role: ProducerRole;
  phase: TaskPhase;
  after: TaskPhase;
} {
  if (phase === "tests") return { role: "test-writer", phase: "tests", after: "exec" };
  if (phase === "exec") return { role: "implementer", phase: "exec", after: "verify" };
  throw new UsageError(`phase must be a producer phase (tests | exec), got '${phase}'`);
}

/** Record the producer status into state and return the next-step envelope. */
export async function applyRecordProducer(
  state: StateManager,
  runId: string,
  taskId: string,
  phase: string,
  statusLine: string,
): Promise<TransitionEnvelope> {
  const info = producerPhaseInfo(phase);
  // Defensive: nextPhase(phase) must equal the hardcoded resume target — keeps the
  // mapping honest if the phase order ever changes (LOUD on drift, never silent).
  if (nextPhase(info.phase) !== info.after) {
    throw new Error(
      `record-producer: phase order drift — nextPhase('${info.phase}') !== '${info.after}'`,
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
    { role: info.role, phase: info.phase, resumePhase: info.after },
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

/** The holdout-validation evidence document `applyRecordHoldout` records. */
export interface RecordHoldoutEnvelope {
  readonly run_id: string;
  readonly task_id: string;
  /** The DERIVED holdout gate evidence (recorded into the merge gate by record-reviews). */
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

/** Record the holdout-validator output: persist raw verdicts + emit derived evidence. */
export async function applyRecordHoldout(
  deps: RecordDeps,
  runId: string,
  taskId: string,
  verdictStore: HoldoutVerdictStore,
  raw: string,
): Promise<RecordHoldoutEnvelope> {
  if (!(await deps.holdout.has(runId, taskId))) {
    throw new Error(
      `record-holdout: task '${taskId}' has no withheld answer key — nothing to validate ` +
        `(applyRecordHoldout must only record when the coroutine surfaced a holdout holdout)`,
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

/** The verify-record envelope `applyRecordReviews` produces. */
export interface RecordReviewsEnvelope extends TransitionEnvelope {
  /** The per-reviewer results this round derived (audit; state may clear them on retry). */
  readonly reviewers: readonly ReviewerResult[];
  /** The DERIVED merge gate verdict (never stored; recomputed here). */
  readonly mergeGate: GateVerdict;
  /**
   * Δ U — a SECOND-VENDOR ABSENCE surfaced from {@link runPanel}. Present (with a
   * reason) IFF this verify pass ran WITHOUT an independent cross-vendor reviewer;
   * the record also emits a LOUD `log.warn` so the absence is never silently swallowed
   * (runPanel records it on the panel result, but the record is the last hop that can
   * drop it). An audit/strength signal only — it NEVER gates the merge gate. Left absent
   * when a second vendor was present.
   */
  readonly crossVendorAbsence?: { readonly reason: string };
}

/**
 * Build a {@link SourceReader} over the task worktree for citation-verify: async-load
 * every cited file ONCE into a map, then serve `readLines` synchronously.
 *
 * Only ENOENT — the cited file is genuinely ABSENT from the worktree — maps to
 * `null` (its citations are then unverifiable and dropped). Any OTHER read error
 * (EACCES, EISDIR, an I/O fault) is a REAL failure and RETHROWS: demoting it to
 * "missing" would silently drop a citation that may back a real blocker, turning a
 * read fault into a false merge-gate-pass. Fail loud instead.
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
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      lines.set(file, null); // genuinely absent → unverifiable → dropped
    }
  }
  return { readLines: (file) => lines.get(file) ?? null };
}

/**
 * Build the REPLAY {@link FindingVerifierRunner} factory: for each reviewer, a runner
 * whose `confirm` returns the orchestrator's pre-recorded verdict for that finding
 * (matched by `file:line`, FIFO among duplicates) instead of spawning. A kept finding
 * with NO recorded verdict REJECTS — `confirmBlocker` turns that into a LOUD `error`
 * (fail-closed: the merge gate blocks, never a silent pass).
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
 * Record the panel + verify-then-fix verdicts into the merge gate and return the next-step
 * envelope. `verdictStore` is the holdout-verdict source `applyRecordHoldout` persisted.
 */
export async function applyRecordReviews(
  deps: RecordDeps,
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
    baseRef: resolveStagingBranch(runId, run.staging_branch),
    config: deps.config,
    tools: deps.tools,
    exemptReader: taskExemptReader(deps, worktree),
  };
  const gate = await new GateRunner().run(gateCtx);
  const gateEvidence: GateEvidence[] = [...gate.evidence];

  // 3. holdout gate evidence — RE-DERIVED from the verdicts applyRecordHoldout persisted
  //    (derive-don't-store exception). A withheld key with no persisted verdicts is an
  //    orchestration error (applyRecordHoldout must record first) — LOUD, never a silent pass.
  if (await deps.holdout.has(runId, taskId)) {
    const record = await deps.holdout.get(runId, taskId);
    const verdicts = await verdictStore.get(runId, taskId);
    gateEvidence.push(
      holdoutEvidence(checkHoldout(record, verdicts, deps.config.quality.holdoutPassRate)),
    );
  }

  // 4. derive the merge gate (citation-verify + replay-confirm + conjunctive merge gate).
  const panel = await runPanel({
    reviews,
    source,
    makeRunner,
    gateEvidence,
    phase: "verify",
    attempt: task.escalation_rung + 1,
    maxAttempts: ESCALATION_CAP + 1,
    ...(input.crossVendorAbsent !== undefined
      ? { crossVendor: { status: "absent", reason: input.crossVendorAbsent.reason } as const }
      : {}),
  });

  // Δ U: a second-vendor absence must be LOUD, never silently dropped. runPanel
  // records it on the result; this record (the last hop) surfaces it as a warn line
  // AND threads it onto the envelope below. It is a strength signal — it does NOT
  // gate the merge gate.
  if (panel.crossVendorAbsence !== undefined) {
    log.warn(
      `task '${taskId}' verify ran WITHOUT an independent cross-vendor reviewer: ` +
        panel.crossVendorAbsence.reason,
    );
  }

  // 5+6. Act on the derived result through the SHARED ladder.
  //
  // Crash-safety invariant (fail-closed): reviewers are persisted ONLY on the
  // advance branch, in the SAME updateTask call that stamps the cursor. On the
  // escalate/fail branch we do NOT persist reviewers — escalateOrFail owns its
  // own state write. A crash before the single advance-write means a no-results
  // re-invoke at verify finds no reviewers → fresh panel spawn (fail-closed);
  // holdout evidence cannot be bypassed by replaying without holdout results.

  let step: TaskStep;
  if (panel.result.kind === "advance") {
    // Persist reviewers + stamp the cursor in ONE locked write (advance branch only).
    // phaseToInFlightStatus is the same mapping markInFlight would apply.
    const nextPhaseVal = panel.result.to;
    const nextStatus = phaseToInFlightStatus(nextPhaseVal);
    await deps.state.updateTask(runId, taskId, (t) => ({
      ...t,
      reviewers: [...panel.reviewerResults],
      phase: nextPhaseVal,
      status: nextStatus,
    }));
    step = { done: false, phase: nextPhaseVal };
  } else if (panel.result.kind === "wait-retry") {
    // escalateOrFail does its own state write; do NOT persist reviewers here.
    step = await escalateOrFail(
      deps,
      runId,
      taskId,
      classifyFailure({ kind: "merge-gate-blocked", reason: panel.result.reason }),
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
    mergeGate: panel.mergeGate,
    ...(panel.crossVendorAbsence !== undefined
      ? { crossVendorAbsence: panel.crossVendorAbsence }
      : {}),
  };
}
