/**
 * WS7 — thin judgment-domain resolution over the FROZEN config seam.
 *
 * This module does NOT introduce defaults — that is the `src/config` seam's job
 * (the "all defaults live in one Zod schema" contract). It only READS already-
 * defined `ConfigSchema` fields and records them into a small, intention-revealing
 * shape the rest of WS7 consumes, so no other WS7 module reaches into the raw
 * `Config` and re-derives the same thing differently.
 *
 * The ONE knob WS7 cannot read straight off the seam is the FIXED reviewer model.
 * Decisions 21/26 + Δ T mandate a single Opus reviewer model identical across all
 * risk tiers; the seam's `review.model` is `optional()` (no committed default —
 * see open question in the plan). WS7 therefore resolves a fixed model HERE and
 * fails LOUD if asked to vary it, rather than scattering a literal or silently
 * defaulting at multiple call sites. When `review.model` is set it is honoured
 * verbatim; when absent the documented fallback below is used. The fallback lives
 * in this single function — not duplicated across panel/finding-verifier — so it
 * is still "one place", and is intended to migrate into `src/config` (WS0-owned)
 * as a committed `review.model` default in a follow-up.
 */
import type {Config} from '../../config/schema.js'

/**
 * The documented FALLBACK reviewer model when `config.review.model` is unset.
 * Decision 21/26 + Δ T: a fixed Opus-class model for the whole panel. Exported so
 * the test asserts the exact value and so a future `src/config` default can be
 * kept in sync. NOT a scattered literal: it is referenced only from
 * {@link resolveReviewModel}.
 */
export const FALLBACK_REVIEW_MODEL = 'opus' as const

/** The judgment-domain view of the config WS7 actually needs. */
export interface JudgmentConfig {
    /** The FIXED reviewer model — identical for every reviewer, every task. */
    readonly reviewModel: string
    /** Cross-vendor (Codex) model id, if configured; else absent. */
    readonly codexModel?: string
    /** Whether retained finding text is redacted before it is surfaced (Δ K). */
    readonly redactFindings: boolean
}

/**
 * Resolve the FIXED reviewer model (Decision 21/26, Δ T). Returns
 * `config.review.model` when set, else {@link FALLBACK_REVIEW_MODEL}. The result
 * is a SINGLE string with no per-task / per-tier input — the type makes varying
 * it structurally impossible (there is nowhere to pass a RiskTier).
 */
export function resolveReviewModel(config: Config): string {
    const m = config.review.model
    if (m?.trim().length === 0) {
        // A configured-but-empty model is a misconfiguration, not "use the default":
        // fail loud rather than silently falling back (Δ T — the model is load-bearing).
        throw new Error('review.model is configured but empty — set a non-empty fixed reviewer model or unset it')
    }
    return m ?? FALLBACK_REVIEW_MODEL
}

/**
 * Record the frozen {@link Config} into the {@link JudgmentConfig} WS7 consumes.
 * Pure; reads only existing seam fields.
 */
export function resolveJudgmentConfig(config: Config): JudgmentConfig {
    const base: JudgmentConfig = {
        reviewModel: resolveReviewModel(config),
        redactFindings: config.quality.securityRedactFindings,
    }
    return config.codex.model !== undefined ? {...base, codexModel: config.codex.model} : base
}
