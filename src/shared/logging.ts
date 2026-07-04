/**
 * Structured logger — frozen seam (WS1+ import {@link createLogger}).
 *
 * Mirrors the bash `log_info/log_warn/log_error` convention from
 * `bin/pipeline-lib.sh`:
 *   - Format:  `[<ISO-8601 UTC>] [<LEVEL>] <scope>: <message>`
 *   - Sink:    ALWAYS stderr. stdout is reserved for machine-parseable output
 *              (JSON results, hook decisions), so logs never corrupt it.
 *
 * Env controls (read at log time, so tests/processes can flip them):
 *   - FACTORY_QUIET=1        → suppress info+warn (errors still emit). Mirrors
 *                              the bash `human_summary` quiet gate.
 *   - FACTORY_LOG_LEVEL=...  → one of debug|info|warn|error|silent. Default info.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel | 'silent', number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 100,
}

/** Resolve the active threshold from env each call (cheap, test-friendly). */
function activeThreshold(): number {
    const raw = (process.env.FACTORY_LOG_LEVEL ?? '').trim().toLowerCase()
    if (raw && raw in LEVEL_RANK) {
        return LEVEL_RANK[raw as LogLevel | 'silent']
    }
    // FACTORY_QUIET raises the floor to warn-suppressed: only errors get through.
    if (process.env.FACTORY_QUIET === '1') {
        return LEVEL_RANK.error
    }
    return LEVEL_RANK.info
}

function emit(level: LogLevel, scope: string, args: unknown[]): void {
    if (LEVEL_RANK[level] < activeThreshold()) {
        return
    }
    const ts = new Date().toISOString()
    const msg = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ')
    process.stderr.write(`[${ts}] [${level.toUpperCase()}] ${scope}: ${msg}\n`)
}

function safeStringify(value: unknown): string {
    if (value instanceof Error) {
        return value.stack ?? value.message
    }
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

export interface Logger {
    debug(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
    /** Derive a child logger with a nested scope (`parent:child`). */
    child(subScope: string): Logger
}

/** Create a scoped logger. `scope` typically names the module/subcommand. */
export function createLogger(scope: string): Logger {
    return {
        debug: (...args) => {
            emit('debug', scope, args)
        },
        info: (...args) => {
            emit('info', scope, args)
        },
        warn: (...args) => {
            emit('warn', scope, args)
        },
        error: (...args) => {
            emit('error', scope, args)
        },
        child: (subScope: string) => createLogger(`${scope}:${subScope}`),
    }
}

/** Default top-level logger. */
export const log: Logger = createLogger('factory')
