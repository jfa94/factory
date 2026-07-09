/**
 * `factory score [--run <id>]` — the run-outcome REPORTER (WS12, Decision 22, Δ S).
 *
 * Model A: a read-only reporter. It resolves the run + its durable spec, derives the
 * deterministic partial-run report, and records it into the compact {@link RunSummary}
 * the runner surfaces. Nothing here writes state.
 */
import {EXIT, type ExitCode} from '../../shared/exit-codes.js'
import {openState} from '../wiring.js'
import {parseArgs, UsageError, optionalString} from '../args.js'
import {emitJson, emitHelp} from '../io.js'
import {type StateManager} from '../../core/state/index.js'
import {readCurrentForCwd, type CurrentRunOverrides} from '../current.js'
import {SpecStore} from '../../spec/index.js'
import {buildPartialReport, buildRunSummary, touchMetricOf, missesByLensOf} from '../../scoring/index.js'
import {readMetrics, aggregateReviewerValue, parseReviewRounds} from '../../scoring/index.js'
import {isTerminalRunStatus} from '../../core/state/index.js'
import {withUsageGuard, type Subcommand} from '../registry-types.js'

const HELP = `factory score — report a run's outcome summary (read-only)

Usage:
  factory score [--run <id>]
  factory score --fleet
  factory score --reviewers

  --run            The run to score (defaults to this repo's current run).
  --fleet          Report the touch metric + misses across EVERY run in the store:
                   per-run touches + metric + misses, the fleet touch aggregate
                   sum(completed) / sum(touches), and the miss roll-up
                   (total_misses, misses_per_run over terminal runs, misses_by_lens).
  --reviewers      Report per-lens review value from the review.round telemetry
                   joined with the miss ledger: rounds, confirmed blockers, yield,
                   send-back rate, and misses attributed to each lens. Also the two
                   funnel rates — citation_rate (cited/raised: did the lens quote
                   REAL code?) and confirm_rate (confirmed/cited: did its claims
                   survive an adversarial verifier?). Honest about coverage
                   (runs_covered vs runs_without_events, rounds_without_funnel).

Emits ONE JSON document:
  { kind:"score", summary }
  { kind:"fleet-score", runs, aggregate, total_misses, misses_per_run, misses_by_lens }
  { kind:"reviewer-score", lenses, runs_covered, runs_without_events, cross_vendor_absent_rounds, unattributed_misses, rounds_without_funnel }`

/** `factory score --fleet` — the store-wide touch-metric roll-up (read-only). */
async function runFleet(state: StateManager): Promise<ExitCode> {
    const all = await state.listRuns() // malformed dirs already warn + skip in listRuns
    const runs = all.map((r) => ({
        run_id: r.run_id,
        status: r.status,
        touches: r.human_touches.length,
        metric: touchMetricOf(r),
        misses: r.misses.length,
    }))
    const withLedger = all.filter((r) => r.human_touches.length > 0)
    const totalTouches = withLedger.reduce((n, r) => n + r.human_touches.length, 0)
    const completed = withLedger.filter((r) => r.status === 'completed').length
    const aggregate = totalTouches === 0 ? null : completed / totalTouches

    // 7a — miss roll-up. `misses_per_run` divides by the TERMINAL-run count (a live
    // run's miss history is still open); null when there are no terminal runs so we
    // never fabricate a rate. `misses_by_lens` sums every run's per-lens buckets.
    const totalMisses = all.reduce((n, r) => n + r.misses.length, 0)
    const terminalRuns = all.filter((r) => isTerminalRunStatus(r.status)).length
    const missesPerRun = terminalRuns === 0 ? null : totalMisses / terminalRuns
    const missesByLens: Record<string, number> = {}
    for (const r of all) {
        for (const [lens, n] of Object.entries(missesByLensOf(r))) {
            missesByLens[lens] = (missesByLens[lens] ?? 0) + n
        }
    }

    emitJson({
        kind: 'fleet-score',
        runs,
        aggregate,
        total_misses: totalMisses,
        misses_per_run: missesPerRun,
        misses_by_lens: missesByLens,
    })
    return EXIT.OK
}

/** `factory score --reviewers` — the per-lens review-value roll-up (read-only, 7b). */
async function runReviewers(state: StateManager, dataDir: string): Promise<ExitCode> {
    const all = await state.listRuns() // malformed dirs already warn + skip in listRuns
    const perRun = await Promise.all(
        all.map(async (r) => ({
            run_id: r.run_id,
            misses: r.misses,
            rounds: parseReviewRounds(await readMetrics(dataDir, r.run_id)),
        }))
    )
    emitJson({kind: 'reviewer-score', ...aggregateReviewerValue(perRun)})
    return EXIT.OK
}

export async function runScore(argv: string[], overrides: CurrentRunOverrides = {}): Promise<ExitCode> {
    const args = parseArgs(argv, {booleans: ['fleet', 'reviewers']})
    if (args.flag('help') === true) {
        return emitHelp(HELP)
    }

    const {dataDir, state} = openState()
    if (args.flag('fleet') === true) {
        return runFleet(state)
    }
    if (args.flag('reviewers') === true) {
        return runReviewers(state, dataDir)
    }

    const explicitRun = optionalString(args.flag('run'))
    const runState =
        explicitRun !== undefined ? await state.read(explicitRun) : await readCurrentForCwd(state, overrides)
    if (runState === null) {
        throw new UsageError('score: no --run given and no current run')
    }

    const specStore = new SpecStore({dataDir})
    const request = await specStore.read(runState.spec.repo, runState.spec.spec_id)
    const report = buildPartialReport(runState, request)
    const summary = buildRunSummary(runState, report)

    emitJson({kind: 'score', summary})
    return EXIT.OK
}

export const scoreCommand: Subcommand = {
    describe: "Report a run's outcome summary (read-only)",
    run: withUsageGuard('score', runScore),
}
