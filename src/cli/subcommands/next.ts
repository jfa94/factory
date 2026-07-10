/**
 * `factory next-task [--run <id>]` — the run-level orchestrator: quota gate, checkpoint
 * recovery, cascade-fail, and the ready set. Emits ONE JSON NextTask.
 */
import {EXIT, type ExitCode} from '../../shared/exit-codes.js'
import {parseArgs, UsageError} from '../args.js'
import {emitJson, emitHelp} from '../io.js'
import {loadOrchestratorDeps} from '../wiring.js'
import {nextTask} from '../../orchestrator/index.js'
import {StateManager} from '../../core/state/index.js'
import type {RunState} from '../../core/state/index.js'
import {readCurrentForCwd} from '../current.js'
import {resolveDataDir} from '../../config/index.js'
import {adoptForCli} from '../adoption.js'
import {nowIso} from '../../shared/time.js'
import {createLogger} from '../../shared/index.js'
import type {GitClient, GhClient} from '../../git/index.js'
import {withUsageGuard, type Subcommand} from '../registry-types.js'

const log = createLogger('next-task')

/** Test seam: git/gh clients for the stale-shipping adoption probe + the clock. */
export interface NextOverrides {
    readonly gitClient?: GitClient
    readonly ghClient?: GhClient
    readonly now?: () => string
}

const HELP = `factory next-task — one run-loop step: quota gate, cascade-fail, ready set

Usage:
  factory next-task [--run <id>]      (defaults to this repo's current run)

Emits ONE JSON envelope to stdout. Every variant also carries the self-resolved run
context — run_id, data_dir (canonical), ship_mode — so the runner adopts them
from the first \`next-task\`:
  { kind:"work", run_id, data_dir, ship_mode, ready:[...], cascade_failed:[...], max_parallel, stale:[...], hung:[...] }
  { kind:"finalize", run_id, data_dir, ship_mode, cascade_failed:[...] }  → call \`factory run finalize\`
  { kind:"done", run_id, data_dir, ship_mode, run_status }
  { kind:"pause", run_id, data_dir, ship_mode, scope, reason, resets_at_epoch? }

  factory next-task --assert-owner <session>          (loud-assert current-run ownership)

Ready tasks are ordered in-flight first (crash resume), then pending (spec order).
Throws LOUD on a dependency deadlock.`

/**
 * Loud-assert that this repo's current run is the one the caller expects, by owning
 * session. The runner's FIRST `next-task` omits `--run` and adopts the per-repo
 * current pointer — but `run create` overwrites that pointer (`pointCurrentAt`), so a
 * concurrent create in the SAME checkout can redirect the runner onto the WRONG
 * run (Codex CP3 finding); in live mode that opens/merges PRs for a foreign run.
 * When the runner passes `--assert-owner "$CLAUDE_CODE_SESSION_ID"`, a mismatch
 * against the resolved run's persisted `owner_session` FAILS LOUD here instead of
 * silently driving the foreign run. Degrades safely (no assertion) when either the
 * asserted session or the run's owner is unknown — mirrors the Stop gate's
 * best-effort ownership ({@link RunState.owner_session}).
 *
 * This asserts identity, it does NOT spuriously fire: `CLAUDE_CODE_SESSION_ID` is
 * session-scoped and constant across the agent tree (verified — a sub-agent's Bash
 * sees the SAME value as the launching session), so an agent's
 * `"$CLAUDE_CODE_SESSION_ID"` equals the runner-stamped `owner_session` on the
 * happy path. A throw means the current pointer genuinely points at a foreign run.
 */
function assertCurrentOwner(current: RunState, assertOwner: string | boolean | undefined): void {
    const expected = typeof assertOwner === 'string' ? assertOwner.trim() : ''
    if (expected.length === 0) {
        return
    } // no assertion requested / session env unset
    const actual = current.owner_session
    if (actual === undefined) {
        return
    } // run owner unknown → cannot assert (degrade safe)
    if (actual !== expected) {
        throw new Error(
            `next-task: this repo's current run '${current.run_id}' is owned by session '${actual}', ` +
                `but --assert-owner expected '${expected}' — a concurrent 'run create' moved ` +
                `the current pointer onto a foreign run. Pass --run <id> explicitly.`
        )
    }
}

export async function runNextTask(argv: string[], overrides: NextOverrides = {}): Promise<ExitCode> {
    const args = parseArgs(argv, {booleans: []})
    if (args.flag('help') === true) {
        return emitHelp(HELP)
    }
    const explicit = args.flag('run')
    let runId: string
    if (typeof explicit === 'string' && explicit.length > 0) {
        runId = explicit
    } else {
        const dataDir = resolveDataDir({})
        const state = new StateManager({dataDir})
        const current = await readCurrentForCwd(state, {
            ...(overrides.gitClient !== undefined ? {gitClient: overrides.gitClient} : {}),
        })
        if (current === null) {
            throw new UsageError('no --run given and no current run')
        }
        assertCurrentOwner(current, args.flag('assert-owner'))
        runId = current.run_id
    }

    const deps = await loadOrchestratorDeps({runId})
    const result = await nextTask(deps, runId)

    // Adopt a stale SHIPPING task (Decision 60): the "PR merged, crashed before
    // completeTask" wedge. The gate keeps the hot runner loop probe-free — a gh probe
    // fires ONLY when work remains AND an aged in-flight task is actually `shipping`
    // (self-quiets on the first hit, since the flip drops it out of the aged bands).
    // BOTH bands qualify (stale ∪ hung, Decision 66): a crashed-before-recording spawn
    // is typically ancient, so it surfaces as `hung` — the probe must still fire. A gh
    // outage logs and emits unchanged; a real flip recomputes (may free dependents or
    // make the run finalize-ready) and attaches the adoption report.
    if (result.kind === 'work') {
        const run = await deps.state.read(runId)
        const staleShipping = [...result.stale, ...result.hung].some((id) => run.tasks[id]?.status === 'shipping')
        if (staleShipping) {
            const git = overrides.gitClient ?? deps.git
            const gh = overrides.ghClient ?? deps.gh
            const at = overrides.now?.() ?? nowIso()
            const adoption = await adoptForCli({state: deps.state, git, gh, dataDir: deps.dataDir}, run, at)
            if (!adoption.ok) {
                log.warn(`adoption probe failed for run '${runId}': ${adoption.error} — emitting unchanged`)
            } else if (adoption.changed) {
                emitJson({...(await nextTask(deps, runId)), adoption})
                return EXIT.OK
            }
        }
    }

    emitJson(result)
    return EXIT.OK
}

export const nextCommand: Subcommand = {
    describe: 'One run-loop step: quota gate, cascade-fail, emit the ready set',
    run: withUsageGuard('next-task', runNextTask),
}
