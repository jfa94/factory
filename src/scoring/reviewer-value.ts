/**
 * 7b — reviewer-value analysis: does each review lens earn its tokens?
 *
 * A PURE aggregator over the `review.round` telemetry lines ({@link emitMetric},
 * emitted at the record seam) joined with the run-state miss ledger. No IO — the
 * CLI (`factory score --reviewers`) reads `listRuns()` × `readMetrics()` and feeds
 * the parsed rounds + misses in here.
 *
 * Backfill honesty (D49 precedent): pre-7b runs carry NO `review.round` lines, so
 * they contribute nothing and are counted in `runs_without_events` — never
 * interpolated into a lens's numbers. `runs_covered` is the honest denominator.
 */
import {z} from 'zod'
import type {MetricRecord} from './telemetry.js'

/** The `review.round` metric's `data` payload (as emitted by `applyRecordReviews`). */
const ReviewRoundDataSchema = z.object({
    outcome: z.enum(['advance', 'send-back', 'environmental']),
    reviewers: z
        .array(
            z.object({
                reviewer: z.string().min(1),
                confirmed_blockers: z.number().int().min(0).default(0),
                /**
                 * The two funnel denominators (7b/2). `.optional()`, NEVER `.default(0)`:
                 * a pre-7b/2 round genuinely has no denominator, and a fabricated `0`
                 * would read as "raised nothing" — indistinguishable from a lens that
                 * raised findings and had them all dropped. Absent ⇒ excluded from the
                 * rates and counted in `rounds_without_funnel` (D49 backfill honesty).
                 */
                raised_blockers: z.number().int().min(0).optional(),
                cited_blockers: z.number().int().min(0).optional(),
            })
        )
        .default([]),
    cross_vendor_absent: z.boolean().optional(),
})
export type ReviewRound = z.infer<typeof ReviewRoundDataSchema>

/** One run's contribution: its parsed review rounds + its miss ledger. */
export interface ReviewerValueRun {
    run_id: string
    misses: readonly {lens?: string | undefined}[]
    rounds: readonly ReviewRound[]
}

/** Per-lens value row. `yield`/`send_back_rate` are null when the lens ran 0 rounds. */
export interface LensValue {
    lens: string
    /** Rounds this lens participated in. */
    rounds: number
    /** Total confirmed (verified) blocking findings this lens raised. */
    confirmed_blockers: number
    /** blockers / rounds — the lens's catch density. Null on 0 rounds (never fabricated). */
    yield: number | null
    /** rounds where the lens raised ≥1 confirmed blocker AND the round was sent back / rounds. */
    send_back_rate: number | null
    /**
     * cited / raised — did the lens quote REAL code? Low ⇒ it hallucinates citations
     * and citation-verify drops them. Null when no round carried funnel data.
     */
    citation_rate: number | null
    /**
     * confirmed / cited — did the lens's CLAIMS survive an adversarial verifier? Low ⇒
     * it cites real code but reasons wrongly about it. Accumulated only over
     * non-`environmental` rounds: a verifier error yields no verdict, so counting those
     * findings would score an unresolved finding as unconfirmed. Null on no data.
     */
    confirm_rate: number | null
    /** Misses attributed to this lens by the miss ledger's `lens` field. */
    misses: number
}

/** The reviewer-value report. Deterministic given the inputs. */
export interface ReviewerValueReport {
    lenses: LensValue[]
    /** Runs carrying ≥1 `review.round` line (the honest denominator). */
    runs_covered: number
    /** Runs with NO review-round telemetry (pre-7b / never-reviewed) — contribute nothing. */
    runs_without_events: number
    /** Rounds that ran without an independent cross-vendor reviewer. */
    cross_vendor_absent_rounds: number
    /** Misses with no lens (or `'none'`) — reported apart, never forced onto a lens. */
    unattributed_misses: number
    /**
     * Rounds emitted before the funnel counters existed. They contribute to `rounds`
     * and `yield` but to NEITHER rate — never interpolated (D49 backfill honesty).
     */
    rounds_without_funnel: number
}

/**
 * Parse a run's raw metric lines into the `review.round` rounds this aggregator
 * consumes. Non-review lines and malformed payloads are skipped (telemetry is
 * best-effort jsonl — a garbled line must never poison the report).
 */
export function parseReviewRounds(metrics: readonly MetricRecord[]): ReviewRound[] {
    const out: ReviewRound[] = []
    for (const m of metrics) {
        if (m.event !== 'review.round') {
            continue
        }
        const parsed = ReviewRoundDataSchema.safeParse(m.data)
        if (parsed.success) {
            out.push(parsed.data)
        }
    }
    return out
}

interface LensAcc {
    rounds: number
    confirmed_blockers: number
    send_back_blocker_rounds: number
    misses: number
    /**
     * Funnel counters, accumulated ONLY from rounds that carry them.
     *
     * citation_rate and confirm_rate need DIFFERENT denominators. Citation-verify runs
     * on every round, so an `environmental` round (a verifier errored) still yields a
     * valid raised→cited measurement. But its cited findings never got a verdict, so
     * counting them as unconfirmed would libel the lens. Hence `_resolved`.
     */
    raised: number
    cited: number
    cited_resolved: number
    confirmed_resolved: number
}

/**
 * Aggregate reviewer value across runs. Every lens seen in a round OR named by an
 * miss gets a row; rows are ranked by yield (event-less lenses sink), tie-broken
 * by name for determinism.
 */
export function aggregateReviewerValue(runs: readonly ReviewerValueRun[]): ReviewerValueReport {
    const byLens = new Map<string, LensAcc>()
    const acc = (lens: string): LensAcc => {
        let a = byLens.get(lens)
        if (a === undefined) {
            a = {
                rounds: 0,
                confirmed_blockers: 0,
                send_back_blocker_rounds: 0,
                misses: 0,
                raised: 0,
                cited: 0,
                cited_resolved: 0,
                confirmed_resolved: 0,
            }
            byLens.set(lens, a)
        }
        return a
    }

    let runsCovered = 0
    let runsWithoutEvents = 0
    let crossVendorAbsentRounds = 0
    let unattributedMisses = 0
    let roundsWithoutFunnel = 0

    for (const run of runs) {
        if (run.rounds.length > 0) {
            runsCovered += 1
        } else {
            runsWithoutEvents += 1
        }
        for (const round of run.rounds) {
            if (round.cross_vendor_absent === true) {
                crossVendorAbsentRounds += 1
            }
            // Funnel data is emitted for every lens in a round or for none of them
            // (one emit site), so `every` here is also `some`.
            if (round.reviewers.length > 0 && round.reviewers.every((r) => r.raised_blockers === undefined)) {
                roundsWithoutFunnel += 1
            }
            for (const r of round.reviewers) {
                const a = acc(r.reviewer)
                a.rounds += 1
                a.confirmed_blockers += r.confirmed_blockers
                if (r.confirmed_blockers > 0 && round.outcome === 'send-back') {
                    a.send_back_blocker_rounds += 1
                }
                if (r.raised_blockers !== undefined && r.cited_blockers !== undefined) {
                    a.raised += r.raised_blockers
                    a.cited += r.cited_blockers
                    if (round.outcome !== 'environmental') {
                        a.cited_resolved += r.cited_blockers
                        a.confirmed_resolved += r.confirmed_blockers
                    }
                }
            }
        }
        for (const e of run.misses) {
            if (e.lens !== undefined && e.lens !== 'none') {
                acc(e.lens).misses += 1
            } else {
                unattributedMisses += 1
            }
        }
    }

    const lenses: LensValue[] = [...byLens.entries()]
        .map(([lens, a]) => ({
            lens,
            rounds: a.rounds,
            confirmed_blockers: a.confirmed_blockers,
            yield: a.rounds > 0 ? a.confirmed_blockers / a.rounds : null,
            send_back_rate: a.rounds > 0 ? a.send_back_blocker_rounds / a.rounds : null,
            citation_rate: a.raised > 0 ? a.cited / a.raised : null,
            confirm_rate: a.cited_resolved > 0 ? a.confirmed_resolved / a.cited_resolved : null,
            misses: a.misses,
        }))
        .sort((x, y) => (y.yield ?? -1) - (x.yield ?? -1) || x.lens.localeCompare(y.lens))

    return {
        lenses,
        runs_covered: runsCovered,
        runs_without_events: runsWithoutEvents,
        cross_vendor_absent_rounds: crossVendorAbsentRounds,
        unattributed_misses: unattributedMisses,
        rounds_without_funnel: roundsWithoutFunnel,
    }
}
