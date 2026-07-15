/** Observational Notification hook: record permission prompts without blocking. */
import {EXIT, type ExitCode} from '../shared/exit-codes.js'
import {createLogger} from '../shared/logging.js'
import type {DataDirOptions} from '../config/load.js'
import {emitMetric} from '../scoring/telemetry.js'
import {loadOwnerScopedRun, type ActiveRun, type OwnerScopedRunOptions} from './hook-context.js'
import {parseHookInput, readStdin, sessionIdOf, type HookInput} from './hook-io.js'

const log = createLogger('hook:notification')

export interface NotificationDeps extends DataDirOptions {
    readonly loadRun?: (opts: OwnerScopedRunOptions) => Promise<ActiveRun | null>
    readonly emit?: typeof emitMetric
    readonly readRaw?: () => Promise<string>
}

/** Record a permission notification when it belongs to an active factory run. */
export async function handleNotification(input: HookInput | null, deps: NotificationDeps = {}): Promise<void> {
    if (typeof input?.message !== 'string' || !/permission/i.test(input.message)) {
        return
    }

    const loadRun = deps.loadRun ?? loadOwnerScopedRun
    const sessionId = sessionIdOf(input)
    const env = {...(deps.env ?? process.env)}
    if (sessionId !== undefined) {
        env.CLAUDE_CODE_SESSION_ID = sessionId
    }
    const active = await loadRun({
        ...deps,
        env,
        ...(input.cwd !== undefined ? {cwd: input.cwd} : {}),
    })
    if (active === null) {
        return
    }

    await (deps.emit ?? emitMetric)(active.dataDir, active.run.run_id, 'permission.requested', {
        message: input.message.slice(0, 500),
        ...(sessionId !== undefined ? {session_id: sessionId} : {}),
    })
}

/** Run the fail-quiet observational hook. Notification must never block a session. */
export async function runNotification(_argv: string[] = [], deps: NotificationDeps = {}): Promise<ExitCode> {
    try {
        const raw = deps.readRaw ? await deps.readRaw() : await readStdin()
        await handleNotification(parseHookInput(raw), deps)
    } catch (err) {
        log.error(`Notification handler error: ${(err as Error).message}`)
    }
    return EXIT.OK
}
