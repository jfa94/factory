import {describe, it, expect} from 'vitest'
import {defaultConfig, ConfigSchema} from '../../config/schema.js'
import {FALLBACK_REVIEW_MODEL, resolveReviewModel, resolveJudgmentConfig} from './config.js'

describe('WS7 config (Δ T fixed reviewer model)', () => {
    it('Δ T: falls back to a single fixed Opus model when review.model is unset', () => {
        const cfg = defaultConfig()
        expect(cfg.review.model).toBeUndefined()
        expect(resolveReviewModel(cfg)).toBe(FALLBACK_REVIEW_MODEL)
    })

    it('Δ T: honours an explicitly configured review.model verbatim', () => {
        const cfg = ConfigSchema.parse({review: {model: 'claude-opus-4-8'}})
        expect(resolveReviewModel(cfg)).toBe('claude-opus-4-8')
    })

    it('Δ T: fails LOUD on a configured-but-empty review.model (no silent fallback)', () => {
        const cfg = ConfigSchema.parse({review: {model: '   '}})
        expect(() => resolveReviewModel(cfg)).toThrow(/empty/i)
    })

    it('D26: resolveJudgmentConfig reads fixed model + redaction gate from the seam', () => {
        const cfg = defaultConfig()
        const jc = resolveJudgmentConfig(cfg)
        expect(jc.reviewModel).toBe(FALLBACK_REVIEW_MODEL)
        expect(jc.redactFindings).toBe(cfg.quality.securityRedactFindings)
    })

    it('Δ U: surfaces codex.model for the cross-vendor slot only when configured', () => {
        const without = resolveJudgmentConfig(defaultConfig())
        expect(without.codexModel).toBeUndefined()
        const withCodex = resolveJudgmentConfig(ConfigSchema.parse({codex: {model: 'gpt-5-codex'}}))
        expect(withCodex.codexModel).toBe('gpt-5-codex')
    })
})
