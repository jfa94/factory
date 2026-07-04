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
import {z} from 'zod'
import {createLogger} from '../../shared/index.js'
import type {PanelVerdict} from '../../core/state/index.js'

const log = createLogger('finding')

/**
 * Closed severity vocabulary. A value outside the set is a LOUD parse error.
 * Only `blocking === true` findings gate the merge gate; severity is retained for the
 * audit trail and human report.
 */
export const FindingSeverityEnum = z.enum(['info', 'warning', 'error', 'critical'])
export type FindingSeverity = z.infer<typeof FindingSeverityEnum>

/**
 * A single reviewer finding. `file` + `line` + `quote` form the CITATION the
 * deterministic filter checks (Δ K): the `quote` must substring-match real source
 * at `file:line ±2`. `file`/`line` are OPTIONAL because a reviewer may raise a
 * non-localised concern; such a finding is parseable but uncitable (see
 * {@link isCitable}) and is dropped by citation-verify.
 */
// Base object schema kept separate so .shape is accessible after superRefine wraps it.
const FindingBaseSchema = z.object({
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
    /**
     * The reviewer's ONE-SENTENCE checkable assertion (≤300 chars) — what the
     * independent finding-verifier confirms. Deliberately distinct from
     * `description`: the claim states WHAT is wrong in verifiable form; the
     * description carries the reasoning chain, which must never reach the
     * verifier (anti-anchoring — the verifier confirms independently, it is not
     * led). Required and bounded LOUDLY: an old-format finding without a claim
     * is a ZodError, never a silent fallback to truncated description.
     */
    claim: z.string().min(1).max(300),
    /** Human-facing description of the concern (the reasoning; producer-facing). */
    description: z.string().min(1),
})

export const FindingSchema = FindingBaseSchema.superRefine((finding, ctx) => {
    // T4: file and line are both-or-neither. A half-citation (file without line, or
    // line without file) parses as a valid Finding but isCitable() drops it silently —
    // indistinguishable from an intentionally non-localised concern. Reject loudly so
    // reviewers get a schema error instead of a silent drop.
    const hasFile = finding.file !== undefined
    const hasLine = finding.line !== undefined
    if (hasFile && !hasLine) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['line'],
            message: `finding has 'file' but no 'line' — provide both or neither for a citable finding`,
        })
    }
    if (hasLine && !hasFile) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['file'],
            message: `finding has 'line' but no 'file' — provide both or neither for a citable finding`,
        })
    }
})
export type Finding = z.infer<typeof FindingSchema>

export const RawReviewVerdictEnum = z.enum(['approve', 'blocked', 'error'])
export type RawReviewVerdict = z.infer<typeof RawReviewVerdictEnum>

/**
 * Compile-time drift pin. `RawReviewVerdict` is a deliberately LOCAL enum (no
 * runtime dependency on core/state — see {@link RawReviewSchema}), but its member
 * set MUST stay identical to the panel verdict vocabulary ({@link PanelVerdict}).
 * `_VerdictsEqual` is `true` only when the two unions are mutually assignable, so
 * the `= true` assignment fails to typecheck the instant either enum drifts —
 * catching the divergence at COMPILE time, not just in a test. The `import type`
 * keeps this a type-only edge: zero runtime coupling.
 */
type _VerdictsEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _verdictPin: _VerdictsEqual<RawReviewVerdict, PanelVerdict> = true
void _verdictPin

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
    /**
     * How many findings the reviewer dropped to stay under the findings cap
     * (self-reported per the review-protocol contract). {@link parseRawReview} adds
     * any engine-side truncation overflow on top, so silent cap truncation is
     * always visible rather than reading as full coverage.
     */
    dropped_by_cap: z.number().int().min(0).optional(),
})
export type RawReview = z.infer<typeof RawReviewSchema>

/**
 * Hard per-review findings cap (Decision 43). The charter instructs reviewers to
 * report their top findings by likelihood × impact and self-report the dropped
 * tail as `dropped_by_cap`; this engine-side bound is the deterministic backstop —
 * a review exceeding it is truncated to its FIRST {@link MAX_FINDINGS_PER_REVIEW}
 * entries (the reviewer's own ranking) rather than rejected, because a ZodError on
 * finding #11 would burn an escalation rung on noise.
 */
export const MAX_FINDINGS_PER_REVIEW = 10

// Known top-level keys — derived from schema shape, not hand-maintained.
const KNOWN_REVIEW_KEYS = new Set(Object.keys(RawReviewSchema.shape))
// Known per-finding keys — derived from schema shape, not hand-maintained.
const KNOWN_FINDING_KEYS = new Set(Object.keys(FindingBaseSchema.shape))

/** Detect and warn on unknown keys stripped by Zod in a plain-object value. */
function warnStrippedKeys(
    context: string,
    topObj: unknown,
    topKnown: Set<string>,
    findingsArr: unknown,
    findingKnown: Set<string>
): void {
    const topUnknown: string[] = []
    const findingUnknown: string[] = []

    if (topObj !== null && typeof topObj === 'object' && !Array.isArray(topObj)) {
        for (const k of Object.keys(topObj)) {
            if (!topKnown.has(k)) {
                topUnknown.push(k)
            }
        }
    }

    if (Array.isArray(findingsArr)) {
        for (const f of findingsArr) {
            if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
                for (const k of Object.keys(f as Record<string, unknown>)) {
                    if (!findingKnown.has(k) && !findingUnknown.includes(k)) {
                        findingUnknown.push(k)
                    }
                }
            }
        }
    }

    if (topUnknown.length > 0 || findingUnknown.length > 0) {
        log.warn(
            `review parse: stripped unknown keys from reviewer '${context}' payload: ` +
                `top[${topUnknown.join(', ')}] findings[${findingUnknown.join(', ')}]`
        )
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
    let result = RawReviewSchema.parse(raw)
    // Derive reviewer label for the warn context (raw may have it before or after parse).
    const rawReviewer =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>).reviewer
            : undefined
    const reviewerLabel = typeof rawReviewer === 'string' ? rawReviewer : result.reviewer
    const rawFindings =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>).findings
            : undefined
    warnStrippedKeys(reviewerLabel, raw, KNOWN_REVIEW_KEYS, rawFindings, KNOWN_FINDING_KEYS)
    if (result.findings.length > MAX_FINDINGS_PER_REVIEW) {
        const overflow = result.findings.length - MAX_FINDINGS_PER_REVIEW
        log.warn(
            `review parse: reviewer '${reviewerLabel}' exceeded the findings cap ` +
                `(${result.findings.length} > ${MAX_FINDINGS_PER_REVIEW}) — kept the first ` +
                `${MAX_FINDINGS_PER_REVIEW}, ${overflow} truncated into dropped_by_cap`
        )
        result = {
            ...result,
            findings: result.findings.slice(0, MAX_FINDINGS_PER_REVIEW),
            dropped_by_cap: (result.dropped_by_cap ?? 0) + overflow,
        }
    }
    if (result.dropped_by_cap !== undefined && result.dropped_by_cap > 0) {
        log.warn(
            `review parse: reviewer '${reviewerLabel}' dropped ${result.dropped_by_cap} finding(s) ` +
                `by cap — coverage is truncated, not exhaustive`
        )
    }
    return result
}

/** Parse + validate a single {@link Finding}. LOUD on malformed input.
 *
 * Unknown keys are stripped (deliberate LLM tolerance) and logged via `log.warn`.
 */
export function parseFinding(raw: unknown): Finding {
    const result = FindingSchema.parse(raw)
    warnStrippedKeys(result.reviewer, raw, KNOWN_FINDING_KEYS, undefined, KNOWN_FINDING_KEYS)
    return result
}

/**
 * A finding is CITABLE iff it carries BOTH a file AND a line — the coordinates
 * the deterministic citation-verify filter needs. An uncitable finding cannot be
 * machine-verified against ground truth and is dropped by citation-verify (Δ K),
 * never silently upheld.
 */
export function isCitable(f: Finding): f is Finding & {file: string; line: number} {
    return f.file !== undefined && f.line !== undefined
}
