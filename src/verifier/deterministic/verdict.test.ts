import {describe, expect, it} from 'vitest'
import {deriveAllGatesVerdict, type GateEvidence} from './verdict.js'

describe("deriveAllGatesVerdict — derive-don't-store conjunction (Δ V)", () => {
    it('an empty gate set FAILS — nothing-ran is never a pass', () => {
        expect(deriveAllGatesVerdict([]).passed).toBe(false)
    })

    it('the conjunction passes only when every gate passes', () => {
        expect(
            deriveAllGatesVerdict([
                {gate: 'test', observed: true},
                {gate: 'coverage', observed: true},
            ]).passed
        ).toBe(true)
        expect(
            deriveAllGatesVerdict([
                {gate: 'test', observed: true},
                {gate: 'coverage', observed: false},
            ]).passed
        ).toBe(false)
    })

    it('is branded as derived and carries a copy of its evidence', () => {
        const evidence: GateEvidence[] = [{gate: 'test', observed: true}]
        const verdict = deriveAllGatesVerdict(evidence)
        expect(verdict.__derived).toBe(true)
        expect(verdict.gate).toBe('all')
        expect(verdict.from).toEqual(evidence)
        expect(verdict.from).not.toBe(evidence)
    })

    it('re-derivation reflects flipped evidence (no cached read)', () => {
        const ev: GateEvidence = {gate: 'mutation', observed: true}
        expect(deriveAllGatesVerdict([ev]).passed).toBe(true)
        ev.observed = false
        expect(deriveAllGatesVerdict([ev]).passed).toBe(false)
    })
})
