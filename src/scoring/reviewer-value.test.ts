/**
 * 7b — the pure reviewer-value aggregator + the review.round metric parser. Proves
 * per-lens yield / send-back rate, the miss join (real lens vs `'none'`/unattributed
 * bucket), and backfill honesty (event-less runs counted, never interpolated).
 */
import {describe, it, expect} from 'vitest'
import {aggregateReviewerValue, parseReviewRounds, type ReviewRound, type ReviewerValueRun} from './reviewer-value.js'
import type {MetricRecord} from './telemetry.js'

/** A review.round with the given per-lens confirmed-blocker counts + outcome. */
function round(
    outcome: ReviewRound['outcome'],
    blockers: Record<string, number>,
    crossVendorAbsent = false
): ReviewRound {
    return {
        outcome,
        reviewers: Object.entries(blockers).map(([reviewer, confirmed_blockers]) => ({reviewer, confirmed_blockers})),
        ...(crossVendorAbsent ? {cross_vendor_absent: true} : {}),
    }
}

/** A review.round carrying the 7b/2 funnel counters: [raised, cited, confirmed] per lens. */
function funnelRound(
    outcome: ReviewRound['outcome'],
    lenses: Record<string, [raised: number, cited: number, confirmed: number]>
): ReviewRound {
    return {
        outcome,
        reviewers: Object.entries(lenses).map(([reviewer, [raised, cited, confirmed]]) => ({
            reviewer,
            confirmed_blockers: confirmed,
            raised_blockers: raised,
            cited_blockers: cited,
        })),
    }
}

function run(over: Partial<ReviewerValueRun> & {run_id: string}): ReviewerValueRun {
    return {misses: [], rounds: [], ...over}
}

describe('aggregateReviewerValue', () => {
    it('computes per-lens rounds, blockers, and yield', () => {
        const report = aggregateReviewerValue([
            run({
                run_id: 'r1',
                rounds: [
                    round('send-back', {'quality-reviewer': 2, 'implementation-reviewer': 0}),
                    round('advance', {'quality-reviewer': 0, 'implementation-reviewer': 0}),
                ],
            }),
        ])
        const q = report.lenses.find((l) => l.lens === 'quality-reviewer')
        expect(q).toMatchObject({rounds: 2, confirmed_blockers: 2, yield: 1}) // 2 blockers / 2 rounds
        const impl = report.lenses.find((l) => l.lens === 'implementation-reviewer')
        expect(impl).toMatchObject({rounds: 2, confirmed_blockers: 0, yield: 0})
    })

    it('send-back rate = blocker-raising send-back rounds / rounds participated', () => {
        const report = aggregateReviewerValue([
            run({
                run_id: 'r1',
                rounds: [
                    round('send-back', {'quality-reviewer': 1}), // counts
                    round('send-back', {'quality-reviewer': 0}), // no blocker → excluded from numerator
                    round('advance', {'quality-reviewer': 3}), // advanced → excluded from numerator
                    round('advance', {'quality-reviewer': 0}),
                ],
            }),
        ])
        const q = report.lenses.find((l) => l.lens === 'quality-reviewer')
        expect(q?.rounds).toBe(4)
        expect(q?.send_back_rate).toBe(0.25) // 1 blocker-raising send-back / 4 rounds
    })

    it('joins misses onto a lens by name; `none`/un-lensed land in unattributed', () => {
        const report = aggregateReviewerValue([
            run({
                run_id: 'r1',
                rounds: [round('advance', {'quality-reviewer': 0})],
                misses: [
                    {lens: 'quality-reviewer'},
                    {lens: 'quality-reviewer'},
                    {lens: 'none'},
                    {}, // un-lensed
                ],
            }),
        ])
        expect(report.lenses.find((l) => l.lens === 'quality-reviewer')?.misses).toBe(2)
        expect(report.unattributed_misses).toBe(2)
    })

    it('a miss naming a lens that never ran still gets a row (rounds 0 → null yield, never fabricated)', () => {
        const report = aggregateReviewerValue([run({run_id: 'r1', misses: [{lens: 'silent-failure-hunter'}]})])
        const l = report.lenses.find((x) => x.lens === 'silent-failure-hunter')
        expect(l).toMatchObject({rounds: 0, misses: 1, yield: null, send_back_rate: null})
    })

    it('counts covered vs event-less runs (backfill honesty — never interpolated)', () => {
        const report = aggregateReviewerValue([
            run({run_id: 'with-events', rounds: [round('advance', {'quality-reviewer': 0})]}),
            run({run_id: 'pre-7b-1'}), // no rounds
            run({run_id: 'pre-7b-2'}),
        ])
        expect(report.runs_covered).toBe(1)
        expect(report.runs_without_events).toBe(2)
    })

    it('tallies cross-vendor-absent rounds', () => {
        const report = aggregateReviewerValue([
            run({
                run_id: 'r1',
                rounds: [
                    round('advance', {'quality-reviewer': 0}, true),
                    round('advance', {'quality-reviewer': 0}, false),
                ],
            }),
        ])
        expect(report.cross_vendor_absent_rounds).toBe(1)
    })

    it('ranks lenses by yield descending, tie-broken by name', () => {
        const report = aggregateReviewerValue([
            run({
                run_id: 'r1',
                rounds: [
                    round('send-back', {
                        'quality-reviewer': 3,
                        'implementation-reviewer': 1,
                        'silent-failure-hunter': 1,
                    }),
                ],
            }),
        ])
        expect(report.lenses.map((l) => l.lens)).toEqual([
            'quality-reviewer', // yield 3
            'implementation-reviewer', // yield 1, name < silent
            'silent-failure-hunter', // yield 1
        ])
    })

    it('splits the funnel: citation_rate = cited/raised, confirm_rate = confirmed/cited', () => {
        const report = aggregateReviewerValue([
            run({run_id: 'r1', rounds: [funnelRound('send-back', {'quality-reviewer': [4, 3, 1]})]}),
        ])
        const q = report.lenses.find((l) => l.lens === 'quality-reviewer')
        expect(q?.citation_rate).toBe(0.75) // 3 of 4 quotes were real source
        expect(q?.confirm_rate).toBe(1 / 3) // 1 of those 3 claims survived refutation
        expect(report.rounds_without_funnel).toBe(0)
    })

    it('an environmental round scores citation_rate but NEVER confirm_rate (no verdict was reached)', () => {
        const report = aggregateReviewerValue([
            run({
                run_id: 'r1',
                rounds: [
                    // Verifier errored: 2 findings cited real code, none got a verdict.
                    funnelRound('environmental', {'quality-reviewer': [2, 2, 0]}),
                ],
            }),
        ])
        const q = report.lenses.find((l) => l.lens === 'quality-reviewer')
        expect(q?.rounds).toBe(1)
        expect(q?.citation_rate).toBe(1) // citation-verify DID run
        expect(q?.confirm_rate).toBeNull() // scoring 0/2 here would libel the lens
    })

    it('mixes an environmental round into the citation denominator but not the confirm one', () => {
        const report = aggregateReviewerValue([
            run({
                run_id: 'r1',
                rounds: [
                    funnelRound('send-back', {'quality-reviewer': [2, 2, 1]}),
                    funnelRound('environmental', {'quality-reviewer': [2, 1, 0]}),
                ],
            }),
        ])
        const q = report.lenses.find((l) => l.lens === 'quality-reviewer')
        expect(q?.citation_rate).toBe(0.75) // (2+1) cited / (2+2) raised
        expect(q?.confirm_rate).toBe(0.5) // 1 confirmed / 2 cited — the environmental round is excluded
    })

    it('a round with no funnel counters yields null rates and counts as rounds_without_funnel', () => {
        const report = aggregateReviewerValue([
            run({run_id: 'r1', rounds: [round('send-back', {'quality-reviewer': 2})]}),
        ])
        const q = report.lenses.find((l) => l.lens === 'quality-reviewer')
        expect(q?.confirmed_blockers).toBe(2) // yield still works
        expect(q?.yield).toBe(2)
        expect(q?.citation_rate).toBeNull() // never a fabricated 0 (D49 backfill honesty)
        expect(q?.confirm_rate).toBeNull()
        expect(report.rounds_without_funnel).toBe(1)
    })

    it('a pre-7b/2 round contributes to yield but not to the rates of a lens that also has funnel rounds', () => {
        const report = aggregateReviewerValue([
            run({
                run_id: 'r1',
                rounds: [
                    round('send-back', {'quality-reviewer': 2}), // no funnel data
                    funnelRound('send-back', {'quality-reviewer': [2, 2, 2]}),
                ],
            }),
        ])
        const q = report.lenses.find((l) => l.lens === 'quality-reviewer')
        expect(q?.rounds).toBe(2)
        expect(q?.yield).toBe(2) // 4 blockers / 2 rounds
        expect(q?.citation_rate).toBe(1) // only the funnel round's 2/2
        expect(q?.confirm_rate).toBe(1)
        expect(report.rounds_without_funnel).toBe(1)
    })

    it('a lens that never raised a blocker has a null citation_rate, not a divide-by-zero', () => {
        const report = aggregateReviewerValue([
            run({run_id: 'r1', rounds: [funnelRound('advance', {'implementation-reviewer': [0, 0, 0]})]}),
        ])
        const impl = report.lenses.find((l) => l.lens === 'implementation-reviewer')
        expect(impl).toMatchObject({rounds: 1, citation_rate: null, confirm_rate: null})
        expect(report.rounds_without_funnel).toBe(0) // the counters WERE emitted; they were just zero
    })
})

describe('parseReviewRounds', () => {
    const metric = (event: string, data?: Record<string, unknown>): MetricRecord => ({
        ts: '2026-07-01T00:00:00.000Z',
        run_id: 'r1',
        event,
        ...(data !== undefined ? {data} : {}),
    })

    it('keeps only review.round lines and coerces the reviewer shape', () => {
        const rounds = parseReviewRounds([
            metric('run.finalized', {foo: 1}),
            metric('review.round', {
                task_id: 't',
                rung: 0,
                outcome: 'send-back',
                reviewers: [{reviewer: 'quality-reviewer', verdict: 'block', confirmed_blockers: 2}],
                cross_vendor_absent: true,
            }),
        ])
        expect(rounds).toHaveLength(1)
        expect(rounds[0]).toEqual({
            outcome: 'send-back',
            reviewers: [{reviewer: 'quality-reviewer', confirmed_blockers: 2}],
            cross_vendor_absent: true,
        })
    })

    it('skips malformed review.round lines rather than poisoning the report', () => {
        const rounds = parseReviewRounds([
            metric('review.round', {outcome: 'not-a-real-outcome'}), // bad enum
            metric('review.round'), // no data
            metric('review.round', {outcome: 'advance'}), // reviewers defaults to []
        ])
        expect(rounds).toEqual([{outcome: 'advance', reviewers: []}])
    })

    it('defaults a missing confirmed_blockers to 0', () => {
        const rounds = parseReviewRounds([
            metric('review.round', {outcome: 'advance', reviewers: [{reviewer: 'quality-reviewer'}]}),
        ])
        expect(rounds[0]?.reviewers[0]).toEqual({reviewer: 'quality-reviewer', confirmed_blockers: 0})
    })

    it('leaves the funnel counters ABSENT when unemitted — never defaulted to 0', () => {
        const rounds = parseReviewRounds([
            metric('review.round', {outcome: 'advance', reviewers: [{reviewer: 'quality-reviewer'}]}),
        ])
        const r = rounds[0]?.reviewers[0]
        expect(r?.raised_blockers).toBeUndefined()
        expect(r?.cited_blockers).toBeUndefined()
    })

    it('parses the funnel counters when present', () => {
        const rounds = parseReviewRounds([
            metric('review.round', {
                outcome: 'send-back',
                reviewers: [
                    {
                        reviewer: 'quality-reviewer',
                        verdict: 'block',
                        confirmed_blockers: 1,
                        raised_blockers: 3,
                        cited_blockers: 2,
                    },
                ],
            }),
        ])
        expect(rounds[0]?.reviewers[0]).toEqual({
            reviewer: 'quality-reviewer',
            confirmed_blockers: 1,
            raised_blockers: 3,
            cited_blockers: 2,
        })
    })
})
