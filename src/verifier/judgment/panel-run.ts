/**
 * WS7 — orchestrates ONE verify pass end-to-end (Decision 26/27, Δ K/T/U).
 *
 * The pipeline, in order:
 *   1. Parse each raw reviewer output → {@link RawReview} (LOUD on malformed).
 *   2. DETERMINISTIC citation-verify (Δ K): drop any blocking finding whose quote
 *      does not substring-match real source at file:line ±2.
 *   3. For every surviving BLOCKING finding, run the INDEPENDENT finding-verifier
 *      (D27) exactly once; only CONFIRMED blockers count. A verifier `error` is
 *      LOUD and UNRESOLVED — it fails the floor, never an auto-approve.
 *   4. Assemble the per-reviewer WS1 {@link ReviewerResult}[] with coherent
 *      counts (approve ⇒ 0 confirmed blockers; blocked ⇒ ≥1), and DERIVE the floor
 *      verdict via the frozen {@link deriveFloorVerdict} — NEVER stored.
 *   5. Map the derived outcome onto a {@link StageResult}: the panel SPAWN manifest
 *      when reviewers must still run; otherwise `advance` (floor passed) or
 *      `wait-retry` (floor blocked — bounded re-review/re-fix). State writes are
 *      the driver's job; this module never touches the StateManager.
 *
 * Producer rebuttal (D27) is a separate, explicitly-driven step (rebuttal.ts);
 * runPanel exposes the confirmed blockers so the driver can route ONE rebuttal
 * before re-deriving. runPanel does not loop a debate.
 */
import {
  advance,
  deriveFloorVerdict,
  spawn,
  waitRetry,
  type GateEvidence,
  type GateVerdict,
  type ReviewerResult,
  type SpawnManifest,
  type StageResult,
  type TaskStage,
} from "../../types/index.js";
import { isCitable, type Finding, type RawReview } from "./finding.js";
import { verifyCitations, type SourceReader } from "./citation-verify.js";
import { confirmBlocker, type FindingVerifierRunner } from "./finding-verifier.js";
import type { CrossVendorResolution } from "./vendor.js";

/** A reviewer's findings after citation-verify + independent confirmation. */
export interface AdjudicatedReviewer {
  /** Reviewer identity (role string). */
  readonly reviewer: string;
  /** The reviewer's raw self-reported verdict (before the floor is derived). */
  readonly rawVerdict: RawReview["verdict"];
  /** Blocking findings that survived citation-verify AND were CONFIRMED. */
  readonly confirmedBlockers: readonly Finding[];
  /** True iff any confirmation was UNRESOLVED (verifier error) — fails LOUDLY. */
  readonly hadVerifierError: boolean;
}

/** The full result of one verify pass. */
export interface PanelRunResult {
  /** Per-reviewer adjudicated detail (audit). */
  readonly adjudicated: readonly AdjudicatedReviewer[];
  /** The WS1 ReviewerResult[] to persist (coherent counts). */
  readonly reviewerResults: readonly ReviewerResult[];
  /** The DERIVED floor verdict (never stored; recomputed here). */
  readonly floor: GateVerdict;
  /** The StageResult the driver acts on. */
  readonly result: StageResult;
  /**
   * Δ U — the LOUD record of a SECOND-VENDOR ABSENCE. Present (with a reason)
   * IFF the caller supplied a {@link RunPanelInput.crossVendor} resolution whose
   * status is `absent`. Left `undefined` when a second vendor IS present or when
   * no resolution was supplied — so a consumer that wants to surface "review ran
   * without an independent vendor" has a non-silent, machine-checkable signal
   * rather than having to re-probe. resolveCrossVendor (vendor.ts) is the source
   * of this resolution; runPanel never papers the absence over.
   */
  readonly crossVendorAbsence?: { readonly reason: string };
}

/**
 * Map ONE raw reviewer through citation-verify + confirmation. A reviewer's
 * `error` self-verdict is preserved (it fails the floor); its blocking findings
 * are still citation-verified + confirmed for the audit trail.
 */
async function adjudicateReviewer(
  review: RawReview,
  source: SourceReader,
  makeRunner: (review: RawReview) => FindingVerifierRunner,
  redact: boolean,
): Promise<AdjudicatedReviewer> {
  const blocking = review.findings.filter((f) => f.blocking);
  const { kept } = verifyCitations(blocking, source, { redact });

  const runner = makeRunner(review);
  const confirmed: Finding[] = [];
  let hadVerifierError = false;

  for (const finding of kept) {
    // Only citable findings reach here (citation-verify drops uncitable ones),
    // but guard for type-narrowing clarity.
    if (!isCitable(finding)) continue;
    const outcome = await confirmBlocker(finding, runner, review.reviewer);
    if (outcome.status === "confirmed") {
      confirmed.push(finding);
    } else if (outcome.status === "error") {
      hadVerifierError = true;
    }
    // refuted ⇒ not forwarded (intentionally dropped from confirmed).
  }

  return {
    reviewer: review.reviewer,
    rawVerdict: review.verdict,
    confirmedBlockers: confirmed,
    hadVerifierError,
  };
}

/**
 * Derive a single reviewer's WS1 verdict from its adjudicated state, coherent
 * with the WS1 superRefine (approve ⇒ 0 confirmed blockers; blocked ⇒ ≥1):
 *   - a verifier error OR the reviewer's own `error` self-verdict ⇒ `error`.
 *   - ≥1 confirmed blocker ⇒ `blocked`.
 *   - otherwise ⇒ `approve`.
 */
function reviewerResultOf(a: AdjudicatedReviewer): ReviewerResult {
  if (a.hadVerifierError || a.rawVerdict === "error") {
    return {
      reviewer: a.reviewer,
      verdict: "error",
      confirmed_blockers: a.confirmedBlockers.length,
    };
  }
  if (a.confirmedBlockers.length > 0) {
    return {
      reviewer: a.reviewer,
      verdict: "blocked",
      confirmed_blockers: a.confirmedBlockers.length,
    };
  }
  return { reviewer: a.reviewer, verdict: "approve", confirmed_blockers: 0 };
}

/** Inputs to {@link runPanel}. */
export interface RunPanelInput {
  /** Raw reviewer outputs (already parsed via parseRawReview). */
  readonly reviews: readonly RawReview[];
  /** Source reader for deterministic citation-verify. */
  readonly source: SourceReader;
  /** Build the INDEPENDENT verifier for a given reviewer's findings (D27). */
  readonly makeRunner: (review: RawReview) => FindingVerifierRunner;
  /** Deterministic-gate evidence to combine with the panel (WS6 supplies it). */
  readonly gateEvidence: readonly GateEvidence[];
  /** The stage to advance/retry at (the verify stage). */
  readonly stage: TaskStage;
  /** Redact retained finding text (Δ K). Defaults to true. */
  readonly redact?: boolean;
  /** Bounded re-review attempt accounting for the wait-retry on a blocked floor. */
  readonly attempt?: number;
  readonly maxAttempts?: number;
  /**
   * Δ U — the resolved cross-vendor slot ({@link resolveCrossVendor}). When its
   * status is `absent`, runPanel records the absence LOUDLY on
   * {@link PanelRunResult.crossVendorAbsence}; when `present` (or omitted) no
   * absence is recorded. The caller resolves it (runPanel stays free of the
   * probe) and hands the resolution in — minimal wiring, no change to floor /
   * citation / confirm semantics.
   */
  readonly crossVendor?: CrossVendorResolution;
}

/**
 * Build the panel SPAWN result — emitted when reviewers must still run (the
 * caller has no raw reviews yet). Kept here so the spawn↔derive paths share one
 * module. The manifest is built by {@link import("./panel.js").buildPanelManifest}
 * and passed in.
 */
export function spawnPanel(manifest: SpawnManifest): StageResult {
  return spawn(manifest);
}

/**
 * Run the full verify pass over already-collected raw reviews and DERIVE the
 * floor. Never stores the verdict; recomputes it via {@link deriveFloorVerdict}.
 */
export async function runPanel(input: RunPanelInput): Promise<PanelRunResult> {
  const redact = input.redact ?? true;

  const adjudicated: AdjudicatedReviewer[] = [];
  for (const review of input.reviews) {
    adjudicated.push(await adjudicateReviewer(review, input.source, input.makeRunner, redact));
  }

  const reviewerResults = adjudicated.map(reviewerResultOf);

  // DERIVE the floor (Δ V / D26): both the deterministic gates and the judgment
  // panel must pass; an `error` reviewer fails it LOUDLY. Never read from storage.
  const floor = deriveFloorVerdict({ reviewers: reviewerResults }, input.gateEvidence);

  const result: StageResult = floor.passed
    ? advance(nextOrSelf(input.stage))
    : waitRetry(
        input.stage,
        floorBlockReason(reviewerResults),
        input.attempt ?? 1,
        input.maxAttempts ?? 1,
      );

  // Δ U: surface a second-vendor ABSENCE loudly on the panel result. We never
  // substitute a same-vendor reviewer into the cross-vendor slot (vendor.ts
  // refuses that); the absence simply becomes a non-silent field the consumer
  // can read. `present` (or an omitted resolution) records nothing.
  const crossVendorAbsence =
    input.crossVendor?.status === "absent" ? { reason: input.crossVendor.reason } : undefined;

  return crossVendorAbsence === undefined
    ? { adjudicated, reviewerResults, floor, result }
    : { adjudicated, reviewerResults, floor, result, crossVendorAbsence };
}

/**
 * The stage to advance to when the floor passes. The verify stage's success
 * advances to the next per-task stage; if `verify` is the configured stage we
 * advance to `ship`. We keep this local rather than importing nextStage to avoid
 * coupling the orchestration to the stage-order walk — but the seam's order is the
 * source of truth, so we mirror only the verify→ship edge WS7 owns.
 */
function nextOrSelf(stage: TaskStage): TaskStage {
  return stage === "verify" ? "ship" : stage;
}

/** A human-facing reason summarising why the floor is blocked. */
function floorBlockReason(results: readonly ReviewerResult[]): string {
  const errored = results.filter((r) => r.verdict === "error").map((r) => r.reviewer);
  const blocked = results.filter((r) => r.verdict === "blocked").map((r) => r.reviewer);
  const parts: string[] = [];
  if (blocked.length > 0) parts.push(`blocked by: ${blocked.join(", ")}`);
  if (errored.length > 0) parts.push(`unresolved (verifier error): ${errored.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : "floor not unanimous";
}
