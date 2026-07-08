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
            a = {rounds: 0, confirmed_blockers: 0, send_back_blocker_rounds: 0, misses: 0}
            byLens.set(lens, a)
        }
        return a
    }

    let runsCovered = 0
    let runsWithoutEvents = 0
    let crossVendorAbsentRounds = 0
    let unattributedMisses = 0

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
            for (const r of round.reviewers) {
                const a = acc(r.reviewer)
                a.rounds += 1
                a.confirmed_blockers += r.confirmed_blockers
                if (r.confirmed_blockers > 0 && round.outcome === 'send-back') {
                    a.send_back_blocker_rounds += 1
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
            misses: a.misses,
        }))
        .sort((x, y) => (y.yield ?? -1) - (x.yield ?? -1) || x.lens.localeCompare(y.lens))

    return {
        lenses,
        runs_covered: runsCovered,
        runs_without_events: runsWithoutEvents,
        cross_vendor_absent_rounds: crossVendorAbsentRounds,
        unattributed_misses: unattributedMisses,
    }
}
