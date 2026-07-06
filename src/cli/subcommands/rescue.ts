/**
 * `factory rescue <scan|apply|auto>` — the repair plumbing behind `/factory:resume`
 * (Decision 50, superseding Decision 48's `factory recover`).
 *
 * Model A: `scan` is a read-only REPORTER whose envelope IS the proposed repair
 * plan the `/factory:resume` command renders for human approval (route + per-repair
 * `hints`, exact apply commands); `apply` is the only WRITER, executing the approved
 * subset; `auto` is the runner's bounded self-heal (ONE cycle per run, after a
 * failed finalize). The CLI never prompts and never spawns agents — consent and the
 * rescue-diagnostic/rescue-reconciler spawns live in the command/skill layer.
 */
import {EXIT, type ExitCode} from '../../shared/exit-codes.js'
import {openState} from '../wiring.js'
import {parseArgs, UsageError} from '../args.js'
import {emitJson, emitLine, emitHelp} from '../io.js'
import {loadConfig} from '../../config/index.js'
import {type StateManager} from '../../core/state/index.js'
import {readCurrentForCwd, type CurrentRunOverrides, resolveRunIdOrCurrent} from '../current.js'
import {scanRun, applyRescue, assessWork, type RescueScan, type WorkProbe} from '../../rescue/index.js'
import {DefaultGitClient, DefaultGhClient, type GhClient} from '../../git/index.js'
import {StatuslineUsageSignal} from '../../quota/index.js'
import {nowEpoch, nowIso} from '../../shared/time.js'
import {applyResume} from '../../orchestrator/lifecycle.js'
import {emitMetric, selfHealCommentMarker} from '../../scoring/index.js'
import {requireAutonomousMode} from '../../autonomy/mode.js'
import {withUsageGuard, type Subcommand} from '../registry-types.js'
import type {RunState} from '../../types/index.js'

const RESCUE_HELP = `factory rescue — repair plumbing behind /factory:resume

Usage:
  factory rescue scan  [--run <id>]
  factory rescue apply [--run <id>] [--task <id>]... [--include-dead-ends] [--reset-e2e] [--recheck-rollup] [--reset-traceability]
  factory rescue auto  [--run <id>]

Actions:
  scan    Classify every task (read-only); report the route + the proposed repair plan.
  apply   Reset the resettable tasks to pending; reopen a terminal run.
  auto    The runner's bounded self-heal (ONE cycle per run, after a failed finalize).`

const SCAN_HELP = `factory rescue scan — classify a stalled run (read-only)

Usage:
  factory rescue scan [--run <id>]

  --run   The run to scan (defaults to runs/current).

Emits ONE JSON document — the proposed repair plan /factory:resume renders:
the RescueScan (counts, resettable, dead_ends, needs_rescue, e2e_failed,
traceability_failed, rollup_pending, would_deadlock, summary, per-task lines)
+ the recoverable-work survey (\`work\`) + the chosen \`route\`
(nothing | resume | repair) + \`reconcile\` (git drift: recorded branch missing /
staging base gone → spawn rescue-reconciler) + \`hints\` (one exact
\`rescue apply\` command per proposable repair) + \`awaiting\` (what a parked run
waits on: quota|e2e|traceability|docs|spec-approval). Writes nothing. A missing
run is a routed {kind:"nothing"} answer, not a usage error — safe to fire blind.`

const APPLY_HELP = `factory rescue apply — reset resettable tasks and reopen a terminal run

Usage:
  factory rescue apply [--run <id>] [--task <id>]... [--include-dead-ends] [--reset-e2e] [--recheck-rollup] [--reset-traceability]

  --run                The run to recover (defaults to runs/current).
  --task               Reset exactly this task (repeatable). Overrides the default
                       resettable set; a 'done' task is a loud error, a 'pending'
                       one is skipped. An explicitly-named dead-end IS reset.
  --include-dead-ends  Also reset dead-end failures (spec-defect / capability-budget).
                       Use only after the root cause is actually fixed.
  --reset-e2e          Clear a failed e2e-phase verdict (Decision 39) so it re-enters
                       and re-derives on the next pass; ALSO drops a failed run-start
                       e2e assessment (Decision 40) so it re-fires fresh. Use only
                       once the underlying cause (flaky infra, an app bug, a
                       since-fixed reopen-cap exhaustion) no longer applies. Alone
                       sufficient to reopen a terminal run even when no task itself
                       is resettable.
  --recheck-rollup     Reopen a 'completed' run whose rollup ARMED but never landed
                       (e.g. the "auto-armed" branch-policy fallback) so a re-drive
                       re-enters finalize and picks up the (by-then) merged PR. Use
                       once you've confirmed the queued merge landed. Alone
                       sufficient to reopen a terminal run.
  --reset-traceability Clear a failed PRD-traceability audit (S9, Decision 47) so it
                       re-enters and re-derives on the next drive. Use once the unmet
                       PRD intent is addressed (or the auditor crash was transient).
                       Alone sufficient to reopen a terminal run.

Default (no --task): resets stuck (crashed in-flight) + recoverable
(blocked-environmental) tasks, leaving dead-ends failed. Reopens a terminal run
to 'running' when it reset work (or when --reset-e2e clears a failed e2e phase,
--reset-traceability clears a failed audit, or --recheck-rollup targets an
armed-not-landed rollup). Idempotent.

Emits ONE JSON document:
  { run_id, run_status, reset:[...], reopened, skipped:[...] }`

const AUTO_HELP = `factory rescue auto — the runner's bounded self-heal (ONE cycle per run)

Usage:
  factory rescue auto [--run <id>]

  --run   The run to self-heal (defaults to runs/current).

Fired by the runner ONCE after a failed finalize: resets the auto-safe set
(stuck + recoverable tasks whose deps are clean post-reset) → {kind:"recovered"},
or pages + posts one deduped comment on the originating PRD → {kind:"page"}.
Never touches dead-ends, e2e verdicts, or rollups (each needs a human assertion
the cause is fixed). Both envelopes exit 0.`

/** Test seam: current-run resolution + gh (the PRD page comment) + the clock. */
export interface RescueOverrides extends CurrentRunOverrides {
    readonly ghClient?: GhClient
    /** ISO clock for `self_heal.last_at` (defaults to {@link nowIso}). */
    readonly now?: () => string
}

/** The route labels `scan` reports and `/factory:resume` switches on. */
export type RescueRoute = 'nothing' | 'resume' | 'repair'

/**
 * What a parked (paused/suspended) run is waiting on — DERIVED from the state
 * markers, never stored (derive-don't-store). Pure display string for the
 * scan envelope; "unknown" is the honest fallback, not an error.
 */
export function deriveAwaiting(run: RunState): string {
    if (run.quota !== undefined) {
        return 'quota'
    } // A2: present ⇔ quota-caused stop
    if (run.e2e_assessment?.status === 'failed' || run.e2e_phase?.status === 'failed') {
        return 'e2e'
    }
    if (run.traceability?.status === 'failed') {
        return 'traceability'
    }
    if (run.docs?.status === 'failed') {
        return 'docs'
    }
    // S9 --approve-spec park: suspended straight after create, no task ever touched.
    const untouched = Object.values(run.tasks).every((t) => t.status === 'pending' && t.started_at === undefined)
    return untouched ? 'spec-approval' : 'unknown'
}

/**
 * Pick the route for a live run (a missing run is handled by the caller).
 * `repair` covers everything the old recover split across `rescue` and `page`:
 * the scan's `hints` say what is proposable, and consent decides what applies.
 */
export function chooseRoute(run: RunState, scan: RescueScan): RescueRoute {
    if (run.status === 'completed' || run.status === 'superseded') {
        return 'nothing' // terminal; a pending rollup surfaces via hints, not a route
    }
    if (scan.needs_rescue || scan.dead_ends.length > 0) {
        return 'repair'
    }
    if (run.status === 'failed') {
        return 'nothing' // terminal with nothing recoverable
    }
    return 'resume' // running/paused/suspended, clean — resume is the idempotent re-entry
}

/** One exact `rescue apply` command per proposable repair — the plan's line items. */
function repairHints(runId: string, scan: RescueScan): string[] {
    const hints: string[] = []
    if (scan.resettable.length > 0) {
        hints.push(`factory rescue apply --run ${runId}`)
    }
    for (const id of scan.dead_ends) {
        hints.push(`factory rescue apply --run ${runId} --task ${id} --include-dead-ends`)
    }
    if (scan.e2e_failed || scan.e2e_assessment_failed) {
        hints.push(`factory rescue apply --run ${runId} --reset-e2e`)
    }
    if (scan.traceability_failed) {
        hints.push(`factory rescue apply --run ${runId} --reset-traceability`)
    }
    if (scan.rollup_pending) {
        hints.push(`factory rescue apply --run ${runId} --recheck-rollup`)
    }
    return hints
}

/** The read-only git probe for {@link assessWork}. */
function probeFrom(overrides: RescueOverrides): WorkProbe {
    const git = overrides.gitClient ?? new DefaultGitClient()
    return {
        refExists: (ref) => git.refExists(ref),
        commitsAhead: (base, branch) => git.commitsAhead(base, branch),
    }
}

export async function runScan(argv: string[], overrides: RescueOverrides = {}): Promise<ExitCode> {
    const args = parseArgs(argv)
    if (args.flag('help') === true) {
        return emitHelp(SCAN_HELP)
    }

    const {state} = openState()

    // A missing run is a routed answer here, not a usage error — the scan behind
    // /factory:resume must be safe to fire blind.
    const explicit = args.flag('run')
    const current =
        typeof explicit === 'string' && explicit.length > 0
            ? await state.read(explicit)
            : await readCurrentForCwd(state, overrides)
    if (current === null) {
        emitJson({kind: 'nothing', reason: 'no-run', route: 'nothing'})
        return EXIT.OK
    }

    const scan = scanRun(current)
    const route = chooseRoute(current, scan)
    const work = await assessWork(current, probeFrom(overrides))
    // v1 drift predicate: a recorded task branch whose ref is gone, or the run's
    // staging base unresolvable. /factory:resume routes reconcile:true to the
    // rescue-reconciler agent; this CLI never spawns it (Model A).
    const reconcile = !work.base_resolved || work.tasks.some((t) => !t.branch_exists)
    const parked = current.status === 'paused' || current.status === 'suspended'
    emitJson({
        ...scan,
        work,
        route,
        reconcile,
        hints: repairHints(current.run_id, scan),
        ...(parked ? {awaiting: deriveAwaiting(current)} : {}),
    })
    return EXIT.OK
}

export async function runApply(argv: string[], overrides: CurrentRunOverrides = {}): Promise<ExitCode> {
    const args = parseArgs(argv, {
        booleans: ['include-dead-ends', 'reset-e2e', 'recheck-rollup', 'reset-traceability'],
    })
    if (args.flag('help') === true) {
        return emitHelp(APPLY_HELP)
    }

    const {dataDir, state} = openState()
    const runId = await resolveRunIdOrCurrent(state, args, 'rescue apply', overrides)
    const tasks = args.all('task')
    const includeDeadEnds = args.flag('include-dead-ends') === true
    const resetE2e = args.flag('reset-e2e') === true
    const recheckRollup = args.flag('recheck-rollup') === true
    const resetTraceability = args.flag('reset-traceability') === true

    const result = await applyRescue(state, runId, {
        ...(tasks.length > 0 ? {tasks} : {}),
        includeDeadEnds,
        resetE2e,
        recheckRollup,
        resetTraceability,
    })
    if (result.touched) {
        await emitMetric(dataDir, runId, 'human_touch', {kind: 'recover'}) // S11 mirror
    }
    // A touched run can still be parked (paused/suspended, non-terminal) — clear it
    // through the same quota gate resume uses, so ONE apply fully re-activates.
    // touch:false — the 'recover' touch above already covers this ONE human action
    // (Decision 49); the /factory:resume tail's `factory resume` then re-enters
    // idempotently and appends nothing.
    const after = await state.read(runId)
    const resume =
        result.touched && (after.status === 'paused' || after.status === 'suspended')
            ? await resumeRun(state, runId, dataDir, {touch: false})
            : undefined
    emitJson({
        ...result,
        ...(resume?.kind === 'resumed' ? {run_status: resume.run.status} : {}),
        ...(resume !== undefined ? {resume} : {}),
    })
    return EXIT.OK
}

/** Post-apply park-clear tail: the resume quota gate, without a second touch. */
async function resumeRun(
    state: StateManager,
    runId: string,
    dataDir: string,
    opts: {touch?: boolean} = {}
): Promise<Awaited<ReturnType<typeof applyResume>>> {
    const reading = await new StatuslineUsageSignal({dataDir}).read()
    return applyResume(state, runId, reading, loadConfig({dataDir}), nowEpoch(), opts)
}

/**
 * The `auto` leg: ONE bounded self-heal cycle. Success recovers; a blocked
 * apply pages AND posts one deduped comment on the originating PRD (the runner
 * is unattended — stdout alone reaches nobody).
 */
export async function runAuto(argv: string[], overrides: RescueOverrides = {}): Promise<ExitCode> {
    const args = parseArgs(argv)
    if (args.flag('help') === true) {
        return emitHelp(AUTO_HELP)
    }
    requireAutonomousMode()

    const {state} = openState()
    const runId = await resolveRunIdOrCurrent(state, args, 'rescue auto', overrides)
    const current = await state.read(runId)
    const scan = scanRun(current)

    const at = overrides.now?.() ?? nowIso()
    const applied = await applyRescue(state, current.run_id, {auto: {at}})

    if (applied.auto_blocked === undefined) {
        emitJson({
            kind: 'recovered',
            run_id: current.run_id,
            run_status: applied.run_status,
            reset: applied.reset,
            reopened: applied.reopened,
            attempts: applied.self_heal_attempts,
        })
        return EXIT.OK
    }

    const reason =
        applied.auto_blocked === 'attempts'
            ? 'self-heal already ran once for this run — human triage required'
            : 'nothing auto-recoverable (dead-ends, blocked dependencies, or no resettable work) — human triage required'

    const gh = overrides.ghClient ?? new DefaultGhClient()
    const marker = selfHealCommentMarker(current.run_id)
    const target = {repo: current.spec.repo, number: current.spec.issue_number}
    const existing = await gh.listIssueComments(target)
    let commented = false
    if (!existing.some((body) => body.includes(marker))) {
        const lines = [marker, `Factory self-heal for run \`${current.run_id}\` did not proceed — ${reason}.`]
        if (scan.dead_ends.length > 0) {
            lines.push('', 'Dead-end task(s) needing a human fix:')
            for (const id of scan.dead_ends) {
                lines.push(`- \`${id}\``)
            }
        }
        lines.push('', `Triage with \`factory rescue scan --run ${current.run_id}\`.`)
        await gh.issueComment({...target, body: lines.join('\n')})
        commented = true
    }

    emitJson({
        kind: 'page',
        run_id: current.run_id,
        run_status: current.status,
        reason,
        dead_ends: scan.dead_ends,
        hints: repairHints(current.run_id, scan),
        commented,
    })
    return EXIT.OK
}

async function run(argv: string[]): Promise<ExitCode> {
    const action = argv[0]
    if (action === undefined || action === '--help' || action === '-h') {
        emitLine(RESCUE_HELP)
        return EXIT.OK
    }
    const rest = argv.slice(1)
    switch (action) {
        case 'scan':
            return runScan(rest)
        case 'apply':
            return runApply(rest)
        case 'auto':
            return runAuto(rest)
        default:
            throw new UsageError(`unknown rescue action '${action}' (expected scan | apply | auto)`)
    }
}

export const rescueCommand: Subcommand = {
    describe: 'Repair plumbing behind /factory:resume: scan (propose), apply (execute approved), auto (self-heal)',
    run: withUsageGuard('rescue', run),
}
