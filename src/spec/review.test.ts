import {describe, it, expect} from 'vitest'
import {parseReviewVerdict, decideSpecReview, type PerDimension, type ReviewVerdict} from './review.js'
import {REVIEW_MAX_TOTAL} from './review.js'
import {SPEC_DEFAULTS} from '../config/index.js'

/** Build a verdict from a per-dimension map (claimed decision/score irrelevant — re-derived). */
function verdict(dims: PerDimension, claimed: Partial<ReviewVerdict> = {}): ReviewVerdict {
    const total =
        dims.granularity +
        dims.dependencies +
        dims.acceptance_criteria +
        dims.tests +
        dims.vertical_slices +
        dims.alignment
    return {
        decision: claimed.decision ?? 'PASS',
        score: claimed.score ?? total,
        per_dimension: dims,
        blockers: claimed.blockers ?? [],
        concerns: claimed.concerns ?? [],
    }
}

const dims = (each: number): PerDimension => ({
    granularity: each,
    dependencies: each,
    acceptance_criteria: each,
    tests: each,
    vertical_slices: each,
    alignment: each,
})

describe('Δ I single threshold 56/60', () => {
    it('Δ I: confirms the threshold is 56 not 54 (default)', () => {
        expect(SPEC_DEFAULTS.passReviewThreshold).toBe(56)
    })

    it('Δ I: PASSes a 56/60 verdict', () => {
        // 9*4 + 10*2 = 56, no dimension <= floor
        const r = decideSpecReview(
            verdict({
                granularity: 9,
                dependencies: 9,
                acceptance_criteria: 9,
                tests: 9,
                vertical_slices: 10,
                alignment: 10,
            })
        )
        expect(r.total).toBe(56)
        expect(r.decision).toBe('PASS')
    })

    it('Δ I: NEEDS_REVISION a 55/60 verdict (below threshold)', () => {
        // 9*5 + 10 = 55
        const r = decideSpecReview(
            verdict({
                granularity: 9,
                dependencies: 9,
                acceptance_criteria: 9,
                tests: 9,
                vertical_slices: 9,
                alignment: 10,
            })
        )
        expect(r.total).toBe(55)
        expect(r.decision).toBe('NEEDS_REVISION')
    })

    it('Δ I: a verdict at exactly 54 NEEDS_REVISION (resolving 54-vs-56 against 54)', () => {
        const r = decideSpecReview(verdict(dims(9))) // 9*6 = 54
        expect(r.total).toBe(54)
        expect(r.decision).toBe('NEEDS_REVISION')
    })

    it('Δ I: re-derives the total and IGNORES a forged claimed decision/score', () => {
        // Claim PASS + score 60 but the dimensions only total 30 → NEEDS_REVISION.
        const r = decideSpecReview(verdict(dims(5), {decision: 'PASS', score: 60}))
        expect(r.total).toBe(30)
        expect(r.decision).toBe('NEEDS_REVISION')
    })

    it('Δ I: every uniform score 0..60 decides consistently with threshold+floor (exhaustive)', () => {
        // Exhaustive sweep over uniform per-dimension scores 1..10 (totals 6..60).
        for (let each = 1; each <= 10; each++) {
            const r = decideSpecReview(verdict(dims(each)))
            const total = each * 6
            const expected =
                each <= SPEC_DEFAULTS.dimensionFloor
                    ? 'NEEDS_REVISION'
                    : total >= SPEC_DEFAULTS.passReviewThreshold
                      ? 'PASS'
                      : 'NEEDS_REVISION'
            expect(r.total).toBe(total)
            expect(r.decision).toBe(expected)
        }
    })
})

describe('Δ I auto-fail floor (any dimension ≤5)', () => {
    it('Δ I: a high-total verdict with one dimension at the floor NEEDS_REVISION', () => {
        // five 10s + one 5 = 55; the dim=5 trips the floor regardless of the total.
        const r = decideSpecReview(
            verdict({
                granularity: 10,
                dependencies: 10,
                acceptance_criteria: 10,
                tests: 10,
                vertical_slices: 10,
                alignment: 5,
            })
        )
        expect(r.decision).toBe('NEEDS_REVISION')
        expect(r.floorFailures).toContain('alignment')
    })

    it('Δ I: floor overrides even a perfect-elsewhere spec that clears the total', () => {
        // Make total >= 56 while keeping one dim at the floor: impossible with one dim=5
        // and five 10s (=55). Use floor=4 override so total can exceed threshold.
        const r = decideSpecReview(
            verdict({
                granularity: 10,
                dependencies: 10,
                acceptance_criteria: 10,
                tests: 10,
                vertical_slices: 10,
                alignment: 6,
            }),
            {dimensionFloor: 6}
        )
        expect(r.total).toBe(56)
        expect(r.total).toBeGreaterThanOrEqual(SPEC_DEFAULTS.passReviewThreshold)
        expect(r.decision).toBe('NEEDS_REVISION')
        expect(r.floorFailures).toContain('alignment')
    })

    it('Δ I: no floor failures + total >= threshold ⇒ PASS', () => {
        const r = decideSpecReview(dims10Plus())
        expect(r.decision).toBe('PASS')
        expect(r.floorFailures).toEqual([])
    })
})

function dims10Plus(): ReviewVerdict {
    return verdict(dims(10)) // 60, all clear
}

describe('parseReviewVerdict — loud on malformed input', () => {
    it('rejects a verdict missing a dimension', () => {
        expect(() =>
            parseReviewVerdict({
                decision: 'PASS',
                score: 50,
                per_dimension: {
                    granularity: 9,
                    dependencies: 9,
                    acceptance_criteria: 9,
                    tests: 9,
                    vertical_slices: 9,
                },
            })
        ).toThrow()
    })

    it('rejects an out-of-range dimension score', () => {
        expect(() =>
            parseReviewVerdict({
                decision: 'PASS',
                score: 60,
                per_dimension: {...dims(10), alignment: 11},
            })
        ).toThrow()
    })

    it('rejects an unknown extra dimension (strict)', () => {
        expect(() =>
            parseReviewVerdict({
                decision: 'PASS',
                score: 60,
                per_dimension: {...dims(10), extra_axis: 10},
            })
        ).toThrow()
    })

    it(`caps total at ${REVIEW_MAX_TOTAL}`, () => {
        expect(() => parseReviewVerdict({decision: 'PASS', score: 61, per_dimension: dims(10)})).toThrow()
    })

    it('defaults blockers/concerns to empty arrays', () => {
        const v = parseReviewVerdict({decision: 'PASS', score: 60, per_dimension: dims(10)})
        expect(v.blockers).toEqual([])
        expect(v.concerns).toEqual([])
    })
})
