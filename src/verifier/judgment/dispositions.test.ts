import {describe, it, expect} from 'vitest'
import type {ReviewDisposition} from '../../core/state/index.js'
import {parseRawReview} from './finding.js'
import type {AdjudicatedReviewer} from './panel-run.js'
import {composeDispositions, appendDispositions, renderDispositionLedger, DISPOSITION_CAP} from './dispositions.js'

function finding(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
        reviewer: 'quality-reviewer',
        severity: 'critical',
        blocking: true,
        file: 'src/app.ts',
        line: 2,
        quote: 'const value = process(input);',
        claim: 'process() can throw on empty input',
        description: 'issue',
        ...over,
    }
}

function adjudicated(over: Partial<AdjudicatedReviewer> = {}): AdjudicatedReviewer {
    return {
        reviewer: 'quality-reviewer',
        rawVerdict: 'blocked',
        confirmedBlockers: [],
        refuted: [],
        hadVerifierError: false,
        raisedBlockers: 0,
        citedBlockers: 0,
        ...over,
    }
}

function dispo(over: Partial<ReviewDisposition> = {}): ReviewDisposition {
    return {
        reviewer: 'quality-reviewer',
        disposition: 'refuted',
        file: 'src/app.ts',
        line: 2,
        quote: 'const value = process(input);',
        claim: 'process() can throw on empty input',
        note: 'process() validates input on entry',
        round: 1,
        ...over,
    }
}

describe('composeDispositions (D68)', () => {
    it('composes refuted blockers (with reason) + non-blocking findings; confirmed blockers excluded', () => {
        const [refutedFinding] = parseRawReview({
            reviewer: 'quality-reviewer',
            verdict: 'blocked',
            findings: [finding()],
        }).findings
        if (refutedFinding === undefined) {
            throw new Error('fixture parse produced no finding')
        }
        const review = parseRawReview({
            reviewer: 'silent-failure-hunter',
            verdict: 'approve',
            findings: [
                finding({
                    reviewer: 'silent-failure-hunter',
                    blocking: false,
                    claim: 'log-only catch',
                    severity: 'warning',
                }),
                finding({reviewer: 'silent-failure-hunter', claim: 'a confirmed blocker'}),
            ],
        })
        const out = composeDispositions(
            [review],
            [adjudicated({refuted: [{finding: refutedFinding, reason: 'input validated upstream'}]})],
            2
        )
        expect(out).toHaveLength(2)
        expect(out[0]).toMatchObject({
            disposition: 'refuted',
            reviewer: 'quality-reviewer',
            note: 'input validated upstream',
            round: 2,
        })
        expect(out[1]).toMatchObject({disposition: 'non-blocking', claim: 'log-only catch', round: 2})
        // the blocking finding from the raw review is NOT a disposition (it gates or gets refuted)
        expect(out.some((d) => d.claim === 'a confirmed blocker')).toBe(false)
    })

    it('citation-dropped blockers never become dispositions (only verifier-refuted do)', () => {
        // A blocking finding that was citation-dropped appears in neither `refuted`
        // nor as non-blocking — compose sees only what the caller hands it.
        const out = composeDispositions([], [adjudicated()], 1)
        expect(out).toEqual([])
    })
})

describe('appendDispositions (D68)', () => {
    it('dedupes by file|quote|claim fingerprint, latest round wins', () => {
        const merged = appendDispositions([dispo({round: 1, note: 'old'})], [dispo({round: 2, note: 'new'})])
        expect(merged).toHaveLength(1)
        expect(merged[0]).toMatchObject({round: 2, note: 'new'})
    })

    it('fingerprint is whitespace/case tolerant on quote+claim but exact on file', () => {
        const reworded = dispo({
            round: 2,
            quote: '  const value =   process(input);  ',
            claim: 'PROCESS() can throw on EMPTY input',
        })
        expect(appendDispositions([dispo()], [reworded])).toHaveLength(1)
        expect(appendDispositions([dispo()], [dispo({round: 2, file: 'src/other.ts'})])).toHaveLength(2)
    })

    it('caps at DISPOSITION_CAP keeping the newest rounds', () => {
        const many = Array.from({length: DISPOSITION_CAP + 5}, (_, i) => dispo({claim: `claim ${i}`, round: i + 1}))
        const merged = appendDispositions(undefined, many)
        expect(merged).toHaveLength(DISPOSITION_CAP)
        expect(merged[0]?.round).toBe(6) // oldest 5 dropped
        expect(merged.at(-1)?.round).toBe(DISPOSITION_CAP + 5)
    })
})

describe('renderDispositionLedger (D68)', () => {
    it('returns undefined for an empty/absent ledger', () => {
        expect(renderDispositionLedger(undefined)).toBeUndefined()
        expect(renderDispositionLedger([])).toBeUndefined()
    })

    it('renders a challengeable input document: header, challenge instruction, one line per entry', () => {
        const doc = renderDispositionLedger([
            dispo(),
            dispo({disposition: 'non-blocking', claim: 'other', note: undefined}),
        ])
        expect(doc).toContain('NOT shared belief-state')
        expect(doc).toContain('CHALLENGES PRIOR DISPOSITION:')
        expect(doc).toContain('[refuted, round 1, quality-reviewer] src/app.ts:2')
        expect(doc).toContain('process() validates input on entry')
        expect(doc).toContain('[non-blocking, round 1, quality-reviewer]')
    })
})
