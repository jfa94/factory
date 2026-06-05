/**
 * WS5 — spec-review verdict parsing + adjudication.
 *
 * Δ I — the SINGLE pass threshold. `decideSpecReview` applies ONE threshold
 * (`SPEC_DEFAULTS.passReviewThreshold`, default 56/60 — resolving the legacy
 * 54-vs-56 conflict in favor of 56) AND the any-dimension auto-fail floor
 * (`<= dimensionFloor`, default 5). The floor OVERRIDES the total: a 60-total
 * spec with one dimension at 5 still needs revision.
 *
 * The six rubric dimensions are fixed (granularity, dependencies,
 * acceptance_criteria, tests, vertical_slices, alignment). The verdict is parsed
 * with a strict Zod schema so a missing dimension or an out-of-range score is a
 * LOUD parse error, never a silent zero.
 */
import { z } from "zod";
import { SPEC_DEFAULTS } from "../config/index.js";

/** The number of rubric dimensions; the review verdict must score exactly this many. */
export const REVIEW_DIMENSION_COUNT = 6;

/** Max total a review can score (each of {@link REVIEW_DIMENSION_COUNT} dimensions out of 10). */
export const REVIEW_MAX_TOTAL = REVIEW_DIMENSION_COUNT * 10;

/** The fixed six rubric dimensions, scored 1..10 each. */
const dimScore = z.number().int().min(1).max(10);

export const PerDimensionSchema = z
  .object({
    granularity: dimScore,
    dependencies: dimScore,
    acceptance_criteria: dimScore,
    tests: dimScore,
    vertical_slices: dimScore,
    alignment: dimScore,
  })
  .strict();

export type PerDimension = z.infer<typeof PerDimensionSchema>;

/**
 * The raw reviewer verdict block. `decision`/`score` are what the agent CLAIMS;
 * adjudication ({@link decideSpecReview}) re-derives the outcome from the
 * per-dimension scores rather than trusting the claimed decision (derive-don't-
 * store: a claimed PASS does not make a sub-threshold spec pass).
 */
export const ReviewVerdictSchema = z
  .object({
    decision: z.enum(["PASS", "NEEDS_REVISION"]),
    score: z.number().int().min(0).max(REVIEW_MAX_TOTAL),
    per_dimension: PerDimensionSchema,
    blockers: z.array(z.string()).default([]),
    concerns: z.array(z.string()).default([]),
  })
  .strict();

export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

/** Parse a raw reviewer verdict. LOUD on a missing dimension / bad score. */
export function parseReviewVerdict(raw: unknown): ReviewVerdict {
  return ReviewVerdictSchema.parse(raw);
}

/** The adjudicated spec-review outcome. */
export type SpecReviewDecision = "PASS" | "NEEDS_REVISION";

export interface SpecReviewResult {
  decision: SpecReviewDecision;
  /** The total RE-DERIVED from per_dimension (not the claimed score). */
  total: number;
  /** Human-readable reason for the outcome. */
  reason: string;
  /** Dimensions that tripped the floor, if any. */
  floorFailures: string[];
}

/** Tunable thresholds for {@link decideSpecReview} (defaults to {@link SPEC_DEFAULTS}). */
export interface DecideOptions {
  passReviewThreshold?: number;
  dimensionFloor?: number;
}

/**
 * Adjudicate a parsed verdict with the SINGLE threshold + auto-fail floor (Δ I).
 *
 * Order of operations (the floor is dominant):
 *   1. Re-derive the total from per_dimension (never trust the claimed `score`).
 *   2. Any dimension `<= dimensionFloor` → NEEDS_REVISION (floor overrides total).
 *   3. Total `>= passReviewThreshold` → PASS, else NEEDS_REVISION.
 */
export function decideSpecReview(
  verdict: ReviewVerdict,
  opts: DecideOptions = {},
): SpecReviewResult {
  const threshold = opts.passReviewThreshold ?? SPEC_DEFAULTS.passReviewThreshold;
  const floor = opts.dimensionFloor ?? SPEC_DEFAULTS.dimensionFloor;

  const dims = verdict.per_dimension;
  const total =
    dims.granularity +
    dims.dependencies +
    dims.acceptance_criteria +
    dims.tests +
    dims.vertical_slices +
    dims.alignment;

  const floorFailures = (Object.entries(dims) as [string, number][])
    .filter(([, v]) => v <= floor)
    .map(([k]) => k);

  if (floorFailures.length > 0) {
    return {
      decision: "NEEDS_REVISION",
      total,
      floorFailures,
      reason:
        `auto-fail floor tripped: dimension(s) ${floorFailures.join(", ")} ` +
        `scored <= ${floor} (total ${total}/${REVIEW_MAX_TOTAL})`,
    };
  }

  if (total >= threshold) {
    return {
      decision: "PASS",
      total,
      floorFailures: [],
      reason: `total ${total}/${REVIEW_MAX_TOTAL} >= threshold ${threshold}`,
    };
  }

  return {
    decision: "NEEDS_REVISION",
    total,
    floorFailures: [],
    reason: `total ${total}/${REVIEW_MAX_TOTAL} < threshold ${threshold}`,
  };
}
