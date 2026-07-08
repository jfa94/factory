/**
 * `factory reconcile [--run <id>]` — the GitHub-truth REPORTER (P1, read-only slice).
 *
 * Model A: a read-only reporter over the {@link reconcileRun} module — GitHub
 * facts (PR state per task head, merged SHAs, staging tip, rollup PR state) +
 * classified drift. Nothing here writes state or GitHub; the forward-only
 * adoption writes are P1's next phase and will grow HERE, not in rescue.
 *
 * Unlike `rescue scan` (which CONTAINS a gh outage so the repair entry point
 * keeps working), gh facts are this command's entire job — any gh failure
 * propagates loud (non-zero exit).
 */
import {EXIT, type ExitCode} from '../../shared/exit-codes.js'
import {openState} from '../wiring.js'
import {parseArgs} from '../args.js'
import {emitJson, emitHelp} from '../io.js'
import {resolveRunIdOrCurrent, type CurrentRunOverrides} from '../current.js'
import {reconcileRun} from '../../rescue/index.js'
import {DefaultGhClient, type GhClient} from '../../git/index.js'
import {withUsageGuard, type Subcommand} from '../registry-types.js'

const HELP = `factory reconcile — report GitHub truth vs recorded run state (read-only)

Usage:
  factory reconcile [--run <id>]

  --run   The run to reconcile (defaults to runs/current).

Probes GitHub through the gh seam and classifies state↔GitHub drift:
  merged-unrecorded | closed-unmerged | stale-pr-number | pr-unrecorded |
  branch-missing | staging-missing | rollup-landed

Emits ONE JSON document:
  { kind:"reconcile", run_id, run_status, facts, drifts, rollup_landed }

Writes nothing (drift remedies stay manual for now — each drift line carries
one). Fails loud when gh is unavailable: GitHub facts are this command's whole
job. For a gh-outage-tolerant survey use \`factory rescue scan\` (its \`github\`
section degrades to {ok:false, error}).`

/** Test seam: current-run resolution + gh. */
export interface ReconcileOverrides extends CurrentRunOverrides {
    readonly ghClient?: GhClient
}

export async function runReconcile(argv: string[], overrides: ReconcileOverrides = {}): Promise<ExitCode> {
    const args = parseArgs(argv)
    if (args.flag('help') === true) {
        return emitHelp(HELP)
    }

    const {state} = openState()
    const runId = await resolveRunIdOrCurrent(state, args, 'reconcile', overrides)
    const run = await state.read(runId)

    const gh = overrides.ghClient ?? new DefaultGhClient()
    const report = await reconcileRun(run, gh)

    emitJson({kind: 'reconcile', run_id: run.run_id, run_status: run.status, ...report})
    return EXIT.OK
}

export const reconcileCommand: Subcommand = {
    describe: 'Report GitHub truth vs recorded run state — facts + classified drift (read-only)',
    run: withUsageGuard('reconcile', runReconcile),
}
