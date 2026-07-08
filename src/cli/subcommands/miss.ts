/**
 * `factory miss` — the review-MISS recorder (Decision 61).
 *
 * A MISS is a defect found in shipped factory-produced code, POST-MERGE — the
 * outer-loop signal the inner quality loop can't see. This verb appends one entry to
 * the run's `misses` ledger (a sanctioned stored-EVENT exception to
 * derive-don't-store — human-reported history nothing can re-derive). `factory score`
 * derives the miss metrics from it; there is no metric mirror (a second copy of the
 * same fact) and no gh label.
 *
 * It is a LEDGER: repeats append (dedup is a human problem), and a miss may be
 * recorded long after finalize — the per-repo `runs/current` pointer keeps naming the
 * last run in a checkout, so "record a miss the day after" works from the repo.
 */
import {EXIT, type ExitCode} from '../../shared/exit-codes.js'
import {openState} from '../wiring.js'
import {parseArgs, UsageError, optionalString} from '../args.js'
import {emitJson, emitError, emitHelp} from '../io.js'
import {resolveRunIdOrCurrent, type CurrentRunOverrides} from '../current.js'
import {panelRolesFor} from '../../verifier/judgment/panel.js'
import {nowIso} from '../../shared/time.js'
import {withUsageGuard, type Subcommand} from '../registry-types.js'

const HELP = `factory miss — record a defect the review panel missed post-merge (Decision 61)

Usage:
  factory miss [--run <id>] --task <id> --note <text> [--lens <reviewer|none>]

  --run     The run whose shipped code the defect traces to (defaults to this
            repo's current run — the per-repo pointer keeps naming the last run
            after finalize, so recording a miss days later works).
  --task    The task (∈ the run's tasks) whose code carries the defect.
  --note    REQUIRED human description of the defect (a miss without one is noise).
  --lens    Which reviewer lens SHOULD have caught it, or 'none'. Optional.

It is a LEDGER — repeats append (dedup is a human judgment call), and a not-yet-done
task still records (misses can surface via rollup/partial runs).

Emits ONE JSON document:
  { kind:"miss", run_id, task_id, misses:<new total> }`

/** The lens set the CLI accepts: every panel role (DB specialist included) plus 'none'. */
function validLenses(): readonly string[] {
    return [...panelRolesFor(true), 'none']
}

export async function runMiss(argv: string[], overrides: CurrentRunOverrides = {}): Promise<ExitCode> {
    const args = parseArgs(argv, {booleans: []})
    if (args.flag('help') === true) {
        return emitHelp(HELP)
    }

    const {state} = openState()
    const runId = await resolveRunIdOrCurrent(state, args, 'miss', overrides)
    const run = await state.read(runId)

    const taskId = optionalString(args.flag('task'))
    if (taskId === undefined) {
        throw new UsageError('miss requires --task <id>')
    }
    if (run.tasks[taskId] === undefined) {
        const ids = Object.keys(run.tasks)
        throw new UsageError(
            `unknown --task '${taskId}' in run '${runId}'; valid task ids: ${ids.length > 0 ? ids.join(', ') : '(none)'}`
        )
    }

    const note = optionalString(args.flag('note'))
    if (note === undefined) {
        throw new UsageError('miss requires --note <text> (a miss without a description is noise)')
    }

    const lens = optionalString(args.flag('lens'))
    if (lens !== undefined && !validLenses().includes(lens)) {
        throw new UsageError(`unknown --lens '${lens}'; valid: ${validLenses().join(', ')}`)
    }

    // Not-done tasks still record — misses can surface via rollup/partial runs, and
    // blocking here would lose history. Warn loudly so a mis-attributed task is visible.
    const taskStatus = run.tasks[taskId].status
    if (taskStatus !== 'done') {
        emitError(
            `miss: task '${taskId}' is not 'done' (status '${taskStatus}') — recording anyway; ` +
                `verify the miss traces to this task's shipped code`
        )
    }

    const at = nowIso()
    const updated = await state.update(runId, (s) => ({
        ...s,
        misses: [...s.misses, {task_id: taskId, at, note, ...(lens !== undefined ? {lens} : {})}],
    }))

    emitJson({kind: 'miss', run_id: runId, task_id: taskId, misses: updated.misses.length})
    return EXIT.OK
}

export const missCommand: Subcommand = {
    describe: 'Record a defect the review panel missed post-merge (Decision 61)',
    run: withUsageGuard('miss', runMiss),
}
