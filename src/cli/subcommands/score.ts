/**
 * `factory score [--run <id>]` — the run-outcome REPORTER (WS12, Decision 22, Δ S).
 *
 * Model A: a read-only reporter. It resolves the run + its durable spec, derives the
 * deterministic partial-run report, and records it into the compact {@link RunSummary}
 * the runner surfaces. Nothing here writes state.
 */
import {EXIT, type ExitCode} from '../../shared/exit-codes.js'
import {nonNull} from '../../shared/index.js'
import {parseArgs, UsageError, optionalString} from '../args.js'
import {emitJson, emitLine} from '../io.js'
import {resolveDataDir} from '../../config/index.js'
import {StateManager} from '../../core/state/index.js'
import {readCurrentForCwd, type CurrentRunOverrides} from '../current.js'
import {SpecStore} from '../../spec/index.js'
import {buildPartialReport, buildRunSummary} from '../../scoring/index.js'
import {withUsageGuard, type Subcommand} from '../registry-types.js'

const HELP = `factory score — report a run's outcome summary (read-only)

Usage:
  factory score [--run <id>]
  factory score --fleet

  --run            The run to score (defaults to runs/current).
  --fleet          Report the touch metric across EVERY run in the store (S11):
                   per-run touches + metric, and the fleet aggregate
                   sum(completed) / sum(touches) over runs carrying the ledger.

Emits ONE JSON document:
  { kind:"score", summary }  |  { kind:"fleet-score", runs, aggregate }`

/** S11 — `(completed ? 1 : 0) / touches`, or null without a ledger (legacy run). */
function touchMetricOf(run: {status: string; human_touches?: unknown[] | undefined}): number | null {
    const touches = run.human_touches?.length
    if (touches === undefined || touches === 0) {
        return null
    }
    return (run.status === 'completed' ? 1 : 0) / touches
}

/** `factory score --fleet` — the store-wide touch-metric roll-up (read-only). */
async function runFleet(state: StateManager): Promise<ExitCode> {
    const all = await state.listRuns() // malformed dirs already warn + skip in listRuns
    const runs = all.map((r) => ({
        run_id: r.run_id,
        status: r.status,
        touches: r.human_touches?.length ?? null,
        metric: touchMetricOf(r),
    }))
    const withLedger = all.filter((r) => (r.human_touches?.length ?? 0) > 0)
    const totalTouches = withLedger.reduce((n, r) => n + nonNull(r.human_touches).length, 0)
    const completed = withLedger.filter((r) => r.status === 'completed').length
    const aggregate = totalTouches === 0 ? null : completed / totalTouches
    emitJson({kind: 'fleet-score', runs, aggregate})
    return EXIT.OK
}

export async function runScore(argv: string[], overrides: CurrentRunOverrides = {}): Promise<ExitCode> {
    const args = parseArgs(argv, {booleans: ['fleet']})
    if (args.flag('help') === true) {
        emitLine(HELP)
        return EXIT.OK
    }

    const dataDir = resolveDataDir({})
    const state = new StateManager({dataDir})
    if (args.flag('fleet') === true) {
        return runFleet(state)
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
