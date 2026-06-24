/**
 * WS7 — the judgment-domain Finding type (Δ K).
 *
 * A {@link Finding} is ONE claim a reviewer makes about the code under review.
 * This is an INTERNAL judgment-domain type — distinct from the frozen WS1
 * {@link import("../../types/index.js").ReviewerResult}, which is the PERSISTED,
 * post-adjudication PER-REVIEWER SUMMARY (verdict + confirmed_blocker count). A
 * Finding is the raw, pre-citation-verify, pre-confirmation atom that flows
 * through citation-verify → finding-verifier before it ever turns into
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
import { createLogger } from "../../shared/index.js";
import type { PanelVerdict } from "../../core/state/index.js";

const log = createLogger("finding");

/**
 * Closed severity vocabulary. A value outside the set is a LOUD parse error.
 * Only `blocking === true` findings gate the merge gate; severity is retained for the
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
  /** True iff this finding, if upheld, BLOCKS the merge gate. */
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

export const RawReviewVerdictEnum = z.enum(["approve", "blocked", "error"]);
export type RawReviewVerdict = z.infer<typeof RawReviewVerdictEnum>;

/**
 * Compile-time drift pin. `RawReviewVerdict` is a deliberately LOCAL enum (no
 * runtime dependency on core/state — see {@link RawReviewSchema}), but its member
 * set MUST stay identical to the panel verdict vocabulary ({@link PanelVerdict}).
 * `_VerdictsEqual` is `true` only when the two unions are mutually assignable, so
 * the `= true` assignment fails to typecheck the instant either enum drifts —
 * catching the divergence at COMPILE time, not just in a test. The `import type`
 * keeps this a type-only edge: zero runtime coupling.
 */
type _VerdictsEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _verdictPin: _VerdictsEqual<RawReviewVerdict, PanelVerdict> = true;
void _verdictPin;

/**
 * A raw reviewer output: the reviewer's own verdict plus its findings. `verdict`
 * reuses the frozen {@link import("../../types/index.js").PanelVerdict} vocabulary
 * — but as a closed local enum so this schema has no runtime dependency on a WS1
 * value (the strings are identical, pinned to `PanelVerdict` at compile time by
 * `_verdictPin` above and also asserted in tests). `findings` MUST be an array (a
 * non-array is a LOUD parse error, never coerced).
 *
 * Non-strictness is DELIBERATE: LLM reviewers routinely add cosmetic keys (e.g.
 * `confidence`, `rationale`) and hard-failing on format drift would burn escalation
 * rungs on noise. All load-bearing fields are required+validated — absence fails
 * LOUD (ZodError). Unknown keys are stripped by Zod and logged via `log.warn` so
 * stripping is observable (e.g. a typo'd optional `file` key silently demoting a
 * finding to uncitable is surfaced, not buried).
 */
export const RawReviewSchema = z.object({
  /** The reviewer identity (role string). */
  reviewer: z.string().min(1),
  /** The reviewer's self-reported verdict. */
  verdict: RawReviewVerdictEnum,
  /** Findings raised. May be empty (an `approve` with no findings). */
  findings: z.array(FindingSchema),
});
export type RawReview = z.infer<typeof RawReviewSchema>;

// Known top-level keys — derived from schema shape, not hand-maintained.
const KNOWN_REVIEW_KEYS = new Set(Object.keys(RawReviewSchema.shape));
// Known per-finding keys — derived from schema shape, not hand-maintained.
const KNOWN_FINDING_KEYS = new Set(Object.keys(FindingSchema.shape));

/** Detect and warn on unknown keys stripped by Zod in a plain-object value. */
function warnStrippedKeys(
  context: string,
  topObj: unknown,
  topKnown: Set<string>,
  findingsArr: unknown,
  findingKnown: Set<string>,
): void {
  const topUnknown: string[] = [];
  const findingUnknown: string[] = [];

  if (topObj !== null && typeof topObj === "object" && !Array.isArray(topObj)) {
    for (const k of Object.keys(topObj as Record<string, unknown>)) {
      if (!topKnown.has(k)) topUnknown.push(k);
    }
  }

  if (Array.isArray(findingsArr)) {
    for (const f of findingsArr) {
      if (f !== null && typeof f === "object" && !Array.isArray(f)) {
        for (const k of Object.keys(f as Record<string, unknown>)) {
          if (!findingKnown.has(k) && !findingUnknown.includes(k)) findingUnknown.push(k);
        }
      }
    }
  }

  if (topUnknown.length > 0 || findingUnknown.length > 0) {
    log.warn(
      `review parse: stripped unknown keys from reviewer '${context}' payload: ` +
        `top[${topUnknown.join(", ")}] findings[${findingUnknown.join(", ")}]`,
    );
  }
}

/**
 * Parse + validate an unknown reviewer payload as a {@link RawReview}. LOUD
 * (ZodError) on a bad severity, a missing/empty quote, a non-array `findings`, a
 * non-positive line, or any unknown verdict. The sanctioned validating entry
 * (mirrors WS1 `parseRunState`).
 *
 * Unknown keys are stripped (deliberate LLM tolerance — see {@link RawReviewSchema}
 * JSDoc) and logged via `log.warn` for observability.
 */
export function parseRawReview(raw: unknown): RawReview {
  const result = RawReviewSchema.parse(raw);
  // Derive reviewer label for the warn context (raw may have it before or after parse).
  const reviewerLabel =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? String((raw as Record<string, unknown>).reviewer ?? result.reviewer)
      : result.reviewer;
  const rawFindings =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).findings
      : undefined;
  warnStrippedKeys(reviewerLabel, raw, KNOWN_REVIEW_KEYS, rawFindings, KNOWN_FINDING_KEYS);
  return result;
}

/** Parse + validate a single {@link Finding}. LOUD on malformed input.
 *
 * Unknown keys are stripped (deliberate LLM tolerance) and logged via `log.warn`.
 */
export function parseFinding(raw: unknown): Finding {
  const result = FindingSchema.parse(raw);
  warnStrippedKeys(result.reviewer, raw, KNOWN_FINDING_KEYS, undefined, KNOWN_FINDING_KEYS);
  return result;
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
