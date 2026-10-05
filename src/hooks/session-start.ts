/**
 * SessionStart (compact) hook. A compaction can drop the runner skill from context, so
 * this re-points a session sitting inside a non-terminal run's root or worktree at the
 * absolute skill path and the run's exact next command. Elsewhere it emits nothing.
 */
import {join} from 'node:path'
import {EXIT, type ExitCode} from '../shared/exit-codes.js'
import {resolveDataDir, resolvePluginRoot} from '../config/load.js'
import {FeatureStore, nextCommand} from '../feature/store.js'
import {terminal, type FeatureRun} from '../feature/schema.js'
import {inside} from './feature-guards.js'
import {emitSessionStartContext, readHookInput} from './hook-io.js'

/** The reminder for every non-terminal run containing `cwd`, or undefined when there is none. */
export function sessionReminder(cwd: string, runs: readonly FeatureRun[], pluginRoot: string): string | undefined {
    const matches = runs.filter((run) => !terminal(run) && (inside(run.root, cwd) || inside(run.worktree, cwd)))
    if (matches.length === 0) {
        return undefined
    }
    const skill = join(pluginRoot, 'skills', 'pipeline-runner', 'SKILL.md')
    return [
        '<FACTORY_RUN_REMINDER>',
        ...matches.map((run) => `Factory run ${run.run_id} is ${run.status}. Next: ${nextCommand(run)}`),
        `Before any pipeline action, re-read ${skill} and follow it.`,
        '</FACTORY_RUN_REMINDER>',
    ].join('\n')
}

export interface SessionStartDeps {
    emit?: (s: string) => void
    cwd?: string
    runs?: () => Promise<FeatureRun[]>
    pluginRoot?: string
}

export async function runSessionStart(_argv: string[] = [], deps: SessionStartDeps = {}): Promise<ExitCode> {
    try {
        const cwd = deps.cwd ?? (await readHookInput())?.cwd ?? process.cwd()
        const runs = deps.runs ? await deps.runs() : await new FeatureStore(resolveDataDir()).list()
        const reminder = sessionReminder(cwd, runs, deps.pluginRoot ?? resolvePluginRoot())
        if (reminder !== undefined) {
            emitSessionStartContext(reminder, deps.emit)
        }
        return EXIT.OK
    } catch (error) {
        process.stderr.write(
            `Factory session reminder failed: ${error instanceof Error ? error.message : String(error)}\n`
        )
        return EXIT.ERROR
    }
}
