/**
 * WS5 spec-pipeline constants.
 *
 * CONVENTION TENSION (surfaced as an open question in the WS5 plan): the project
 * rule is "ALL config defaults live in src/config/schema.ts". This run's write
 * scope is restricted to src/spec/, so these spec-pipeline knobs are staged here
 * with a TODO to migrate into a `SpecSchema` sub-block of the canonical config
 * schema. They are exported as a single frozen object so the migration is a
 * mechanical move (and so a downstream caller can inject overrides without
 * scattering literals across WS5).
 *
 * These are NOT scattered literals — every WS5 module that needs a threshold,
 * floor, or cap reads it from {@link SPEC_DEFAULTS} (or an injected override),
 * never a bare number.
 *
 * TODO(config-owner): migrate to ConfigSchema.spec = SpecSchema with these
 * exact defaults, then have the pipeline read them off the resolved Config.
 */

/** Tunable spec-pipeline parameters. */
export interface SpecConfig {
  /**
   * The SINGLE spec-review pass threshold (out of 60), Δ I. Resolves the legacy
   * 54-vs-56 conflict in favor of 56. A verdict total `>= passReviewThreshold`
   * is a candidate PASS (still subject to the per-dimension floor below).
   */
  passReviewThreshold: number;
  /**
   * The any-dimension auto-fail floor (Δ I). Any single rubric dimension whose
   * score is `<= dimensionFloor` forces NEEDS_REVISION regardless of the total.
   */
  dimensionFloor: number;
  /**
   * Max spec generate→review revision iterations before the pipeline gives up
   * loudly (a bounded loop — never spins on an always-blocking reviewer).
   */
  maxRegenIterations: number;
  /**
   * Model the spec generator AND reviewer are pinned to (Decision 21 apex gate).
   * This is the UNCONDITIONAL pin — it is never read per-task or per-risk-tier.
   */
  specModel: string;
  /**
   * Effort the spec generator AND reviewer are pinned to (Decision 21 apex gate).
   * Unconditional, like {@link specModel}.
   */
  specEffort: string;
  /** Max bytes of PRD body retained from `gh issue view` before truncation. */
  prdBodyMaxBytes: number;
}

/** The frozen WS5 defaults. */
export const SPEC_DEFAULTS: Readonly<SpecConfig> = Object.freeze({
  passReviewThreshold: 56,
  dimensionFloor: 5,
  maxRegenIterations: 5,
  specModel: "opus",
  specEffort: "max",
  prdBodyMaxBytes: 64 * 1024,
});

/** The number of rubric dimensions; the review verdict must score exactly this many. */
export const REVIEW_DIMENSION_COUNT = 6;

/** Max total a review can score (each of 6 dimensions out of 10). */
export const REVIEW_MAX_TOTAL = 60;
