/**
 * `factory reconcile [--run <id>]` — the GitHub-truth REPORTER (P1, read-only slice).
 *
 * Model A: a reporter over the {@link reconcileRun} module — GitHub facts (PR
 * state per task head, merged SHAs, staging tip, rollup PR state) + classified
 * drift. Read-only by default; `--adopt` applies the forward-only repairs
 * (Decision 60) against the SAME report — no second gh probe.
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
import {reconcileRun, adoptFromReport} from '../../rescue/index.js'
import {mirrorAdoption} from '../adoption.js'
import {nowIso} from '../../shared/time.js'
import {DefaultGhClient, DefaultGitClient, type GhClient, type GitClient} from '../../git/index.js'
import {withUsageGuard, type Subcommand} from '../registry-types.js'

const HELP = `factory reconcile — report (and optionally adopt) GitHub truth vs run state

Usage:
  factory reconcile [--run <id>] [--adopt]

  --run     The run to reconcile (defaults to runs/current).
  --adopt   Apply the forward-only repairs the report finds (Decision 60):
            record merged-unrecorded PRs as done, rebind stale pr_numbers,
            re-push missing branches, reopen a run whose rollup landed.

Probes GitHub through the gh seam and classifies state↔GitHub drift:
  merged-unrecorded | closed-unmerged | stale-pr-number | pr-unrecorded |
  branch-missing | staging-missing | rollup-landed

Emits ONE JSON document (the \`adoption\` field is present only under --adopt):
  { kind:"reconcile", run_id, run_status, facts, drifts, rollup_landed, adoption? }

Fails loud when gh is unavailable: GitHub facts are this command's whole job.
For a gh-outage-tolerant survey use \`factory rescue scan\` (its \`github\`
section degrades to {ok:false, error}).`

/** Test seam: current-run resolution + git/gh + the adoption clock. */
export interface ReconcileOverrides extends CurrentRunOverrides {
    readonly ghClient?: GhClient
    readonly gitClient?: GitClient
    readonly now?: () => string
}

export async function runReconcile(argv: string[], overrides: ReconcileOverrides = {}): Promise<ExitCode> {
    const args = parseArgs(argv, {booleans: ['adopt']})
    if (args.flag('help') === true) {
        return emitHelp(HELP)
    }

    const {dataDir, state} = openState()
    const runId = await resolveRunIdOrCurrent(state, args, 'reconcile', overrides)
    const run = await state.read(runId)

    const gh = overrides.ghClient ?? new DefaultGhClient()
    const report = await reconcileRun(run, gh)

    // --adopt applies the forward-only repairs against the report we already hold (no
    // second gh probe). Any gh outage already threw above — this command's whole job is
    // GitHub truth, so it stays loud (no {ok:false} containment like the runner sites).
    if (args.flag('adopt') === true) {
        const git = overrides.gitClient ?? new DefaultGitClient()
        const at = overrides.now?.() ?? nowIso()
        const applied = await adoptFromReport({state, git}, run, report, {at})
        const adoption = await mirrorAdoption(dataDir, run.run_id, applied)
        emitJson({kind: 'reconcile', run_id: run.run_id, run_status: run.status, ...report, adoption})
        return EXIT.OK
    }

    emitJson({kind: 'reconcile', run_id: run.run_id, run_status: run.status, ...report})
    return EXIT.OK
}

export const reconcileCommand: Subcommand = {
    describe: 'Report GitHub truth vs recorded run state — facts + classified drift (read-only)',
    run: withUsageGuard('reconcile', runReconcile),
}
