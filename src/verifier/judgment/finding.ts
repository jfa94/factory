/**
 * WS7 — the judgment-domain Finding type (Δ K).
 *
 * A {@link Finding} is ONE claim a reviewer makes about the code under review.
 * This is an INTERNAL judgment-domain type — distinct from the frozen WS1
 * {@link import("../../types/index.js").ReviewerResult}, which is the PERSISTED,
 * post-adjudication PER-REVIEWER SUMMARY (verdict + confirmed_blocker count). A
 * Finding is the raw, pre-citation-verify, pre-confirmation atom that flows
 * through citation-verify → finding-verifier → rebuttal before it ever turns into
 * a confirmed blocker counted in a ReviewerResult.
 *
 * LOUD parsing (mirrors the WS1 closed-enum discipline): a malformed reviewer
 * payload is a ZodError, never a silently-dropped or coerced finding. The one
 * deliberately-tolerant shape is a finding with NO file:line citation — that is
 * PARSEABLE but flagged `uncitable` so the deterministic citation-verify filter
 * (Δ K) can drop it on a machine-checkable rule rather than the parser guessing
 * intent.
 */
import { z } from "zod";

/**
 * Closed severity vocabulary. A value outside the set is a LOUD parse error.
 * Only `blocking === true` findings gate the floor; severity is retained for the
 * audit trail and human report.
 */
export const FindingSeverityEnum = z.enum(["info", "warning", "error", "critical"]);
export type FindingSeverity = z.infer<typeof FindingSeverityEnum>;

/**
 * A single reviewer finding. `file` + `line` + `quote` form the CITATION the
 * deterministic filter checks (Δ K): the `quote` must substring-match real source
 * at `file:line ±2`. `file`/`line` are OPTIONAL because a reviewer may raise a
 * non-localised concern; such a finding is parseable but uncitable (see
 * {@link isCitable}) and is dropped by citation-verify.
 */
export const FindingSchema = z.object({
  /** Which panel reviewer raised this (free-form; the role string). */
  reviewer: z.string().min(1),
  /** Closed severity. */
  severity: FindingSeverityEnum,
  /** True iff this finding, if upheld, BLOCKS the floor. */
  blocking: z.boolean(),
  /** Cited file path (run-tree relative). Absent ⇒ uncitable. */
  file: z.string().min(1).optional(),
  /** Cited 1-based line number. Absent ⇒ uncitable. Must be positive. */
  line: z.number().int().positive().optional(),
  /**
   * The VERBATIM code the reviewer claims to be quoting. Required and non-empty —
   * a finding with no quote cannot be citation-verified, so we reject it loudly
   * rather than admit an unverifiable claim. (An empty string is rejected by
   * `.min(1)`.)
   */
  quote: z.string().min(1),
  /** Human-facing description of the concern. */
  description: z.string().min(1),
});
export type Finding = z.infer<typeof FindingSchema>;

/**
 * A raw reviewer output: the reviewer's own verdict plus its findings. `verdict`
 * reuses the frozen {@link import("../../types/index.js").PanelVerdict} vocabulary
 * — but as a closed local enum so this schema has no runtime dependency on a WS1
 * value (the strings are identical and asserted in tests). `findings` MUST be an
 * array (a non-array is a LOUD parse error, never coerced).
 */
export const RawReviewVerdictEnum = z.enum(["approve", "blocked", "error"]);
export type RawReviewVerdict = z.infer<typeof RawReviewVerdictEnum>;

export const RawReviewSchema = z.object({
  /** The reviewer identity (role string). */
  reviewer: z.string().min(1),
  /** The reviewer's self-reported verdict. */
  verdict: RawReviewVerdictEnum,
  /** Findings raised. May be empty (an `approve` with no findings). */
  findings: z.array(FindingSchema),
});
export type RawReview = z.infer<typeof RawReviewSchema>;

/**
 * Parse + validate an unknown reviewer payload as a {@link RawReview}. LOUD
 * (ZodError) on a bad severity, a missing/empty quote, a non-array `findings`, a
 * non-positive line, or any unknown verdict. The sanctioned validating entry
 * (mirrors WS1 `parseRunState`).
 */
export function parseRawReview(raw: unknown): RawReview {
  return RawReviewSchema.parse(raw);
}

/** Parse + validate a single {@link Finding}. LOUD on malformed input. */
export function parseFinding(raw: unknown): Finding {
  return FindingSchema.parse(raw);
}

/**
 * A finding is CITABLE iff it carries BOTH a file AND a line — the coordinates
 * the deterministic citation-verify filter needs. An uncitable finding cannot be
 * machine-verified against ground truth and is dropped by citation-verify (Δ K),
 * never silently upheld.
 */
export function isCitable(f: Finding): f is Finding & { file: string; line: number } {
  return f.file !== undefined && f.line !== undefined;
}
