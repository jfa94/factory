/**
 * Process / shell exec wrapper — frozen seam.
 *
 * This is the seam WS3 (git / gh wrappers) and WS6 (semgrep / stryker external
 * CLIs) build on. git, gh, jq, semgrep, stryker are EXTERNAL CLIs invoked here,
 * never bundled deps.
 *
 * Discipline (mirrors the bash `git -C` array-arg style):
 *   - No shell by default. Commands are spawned with an explicit argv array, so
 *     there is no word-splitting / glob / injection surface. (A `shell` opt
 *     exists as an escape hatch but defaults off.)
 *   - The result type {@link ExecResult} is FROZEN: downstream parses stdout /
 *     stderr / code from it. A non-zero exit is NOT thrown by default — callers
 *     branch on `code`. Use {@link execOrThrow} when any failure is fatal.
 */
import {spawn} from 'node:child_process'

/** Result of an external command. `code` is null only if killed by a signal. */
export interface ExecResult {
    /** Captured stdout (decoded as utf-8). */
    stdout: string
    /** Captured stderr (decoded as utf-8). */
    stderr: string
    /** Exit code, or null if the process was terminated by a signal. */
    code: number | null
    /** Terminating signal name, if any. */
    signal: NodeJS.Signals | null
    /**
     * True iff stdout or stderr hit `maxBuffer` and was clipped. Lets a parser of
     * large tool output (WS3 gh, WS6 stryker/semgrep JSON) FAIL LOUD on truncation
     * instead of silently mis-parsing a clipped payload.
     */
    truncated: boolean
}

/** Options for {@link exec}. */
export interface ExecOptions {
    /** Working directory for the child process. */
    cwd?: string
    /** Extra/overriding environment variables (merged over process.env by default — see {@link envMode}). */
    env?: Record<string, string | undefined> | undefined
    /**
     * `"merge"` (default): `env` is layered over the full inherited `process.env`.
     * `"replace"`: the child sees ONLY `env` (or `{}` if omitted) — nothing ambient.
     * Used to run untrusted/autonomously-authored code (e2e specs, Decision 39 W5)
     * without handing it the parent's full environment (secrets, tokens, ...).
     */
    envMode?: 'merge' | 'replace' | undefined
    /** String/buffer piped to the child's stdin. */
    input?: string | Uint8Array
    /** Hard timeout in ms; the child is killed with `killSignal` on expiry. */
    timeoutMs?: number
    /** Signal used to kill on timeout (default SIGTERM). */
    killSignal?: NodeJS.Signals
    /** Max bytes captured per stream before truncation (default 16 MiB). */
    maxBuffer?: number
    /**
     * Run through a shell. OFF by default. Only enable for trusted, fully-quoted
     * command strings — defeats the no-injection guarantee.
     */
    shell?: boolean
}

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024

/**
 * Spawn `command` with `args`, capture stdout/stderr, resolve with an
 * {@link ExecResult}. Never rejects on a non-zero exit — only on spawn failure
 * (e.g. ENOENT for a missing binary).
 */
export function exec(command: string, args: readonly string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER

    return new Promise<ExecResult>((resolve, reject) => {
        const child = spawn(command, args as string[], {
            cwd: opts.cwd,
            env: opts.envMode === 'replace' ? (opts.env ?? {}) : opts.env ? {...process.env, ...opts.env} : process.env,
            shell: opts.shell ?? false,
            timeout: opts.timeoutMs,
            killSignal: opts.killSignal ?? 'SIGTERM',
        })

        const outChunks: Buffer[] = []
        const errChunks: Buffer[] = []
        let outLen = 0
        let errLen = 0
        let truncated = false
        let settled = false

        const settleReject = (err: Error) => {
            if (settled) {
                return
            }
            settled = true
            reject(err)
        }

        // Clip each stream to exactly `maxBuffer` bytes (slice the chunk that crosses
        // the cap, don't admit it whole) and record that truncation happened so the
        // caller can react instead of silently parsing a clipped payload.
        child.stdout.on('data', (c: Buffer) => {
            const remaining = maxBuffer - outLen
            if (remaining <= 0) {
                truncated = true
                return
            }
            if (c.length > remaining) {
                outChunks.push(c.subarray(0, remaining))
                outLen = maxBuffer
                truncated = true
            } else {
                outChunks.push(c)
                outLen += c.length
            }
        })
        child.stderr.on('data', (c: Buffer) => {
            const remaining = maxBuffer - errLen
            if (remaining <= 0) {
                truncated = true
                return
            }
            if (c.length > remaining) {
                errChunks.push(c.subarray(0, remaining))
                errLen = maxBuffer
                truncated = true
            } else {
                errChunks.push(c)
                errLen += c.length
            }
        })

        child.on('error', settleReject)

        child.on('close', (code, signal) => {
            if (settled) {
                return
            }
            settled = true
            resolve({
                stdout: Buffer.concat(outChunks).toString('utf8'),
                stderr: Buffer.concat(errChunks).toString('utf8'),
                code,
                signal: signal ?? null,
                truncated,
            })
        })

        if (opts.input !== undefined) {
            child.stdin.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EPIPE') {
                    return
                } // child exited early; close handler reports the result
                settleReject(err)
            })
            child.stdin.end(opts.input)
        }
    })
}

/** Thrown by {@link execOrThrow} when the command exits non-zero or is signalled. */
export class ExecError extends Error {
    readonly result: ExecResult
    readonly command: string
    readonly args: readonly string[]
    constructor(command: string, args: readonly string[], result: ExecResult) {
        const where = [command, ...args].join(' ')
        super(
            `command failed (code=${result.code ?? 'null'}` +
                (result.signal ? `, signal=${result.signal}` : '') +
                `): ${where}\n${result.stderr.trim()}`
        )
        this.name = 'ExecError'
        this.command = command
        this.args = args
        this.result = result
    }
}

/**
 * Like {@link exec}, but rejects with an {@link ExecError} unless the command
 * exits 0. Use when any failure should abort the caller.
 */
export async function execOrThrow(
    command: string,
    args: readonly string[] = [],
    opts: ExecOptions = {}
): Promise<ExecResult> {
    const result = await exec(command, args, opts)
    if (result.code !== 0) {
        throw new ExecError(command, args, result)
    }
    return result
}
