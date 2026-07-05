/**
 * WS9 — PreToolUse Edit|Write|MultiEdit|Bash guard: the primary "implementer
 * cannot modify any TCB path" enforcer (Δ B/W/Y).
 *
 * Edit/Write/MultiEdit: extracts every target file_path from the tool input
 * (Edit/Write `.file_path` plus MultiEdit `.edits[].file_path`), canonicalizes
 * each, and DENIES if ANY is a TCB-protected path ({@link isTcbProtected}).
 *
 * Bash: extracts every WRITE TARGET from the command text — output-redirection
 * RHS (`>`, `>>`, `>|`, `2>`, `&>`), and the destination args of the writing
 * binaries (tee, cp, mv, install, dd of=, sed -i / perl -i, truncate, rm,
 * unlink) — and denies on the same TCB match. A plain top-level redirect is NOT
 * a nested shell, so shell-bypass never sees it; this arm closes that hole.
 *
 * The denylist is HARDCODED in tcb.ts and is NEVER consulted from config — the
 * load-bearing kill of the circular config bypass (Δ W). This is unconditional:
 * it does not depend on a run being active or on config state; an implementer
 * must never write a TCB path.
 *
 * The data dir (so the out-of-repo `runs/**`/`specs/**` stores match at their
 * absolute paths) is resolved best-effort via the Config seam — PATH RESOLUTION
 * only, never policy (see tcb.ts header). If the data dir cannot be resolved the
 * component-anchored TCB rules still fire.
 */
import {EXIT, type ExitCode} from '../shared/exit-codes.js'
import {createLogger, nonNull} from '../shared/index.js'

const log = createLogger('write-protection')
import {resolveDataDir, type DataDirOptions} from '../config/load.js'
import {isTcbProtected, type TcbContext} from './tcb.js'
import {
    allow,
    commandOf,
    deny,
    decisionToExitCode,
    emitPermissionDecision,
    filePathsOf,
    parseHookInput,
    toolNameOf,
    type HookDecision,
    type HookInput,
} from './hook-io.js'

/** Tools that perform a write and are therefore subject to TCB write-deny. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

/** Compound-command / substitution splitter (same idiom as secret-guard). */
const SEGMENT_SPLIT_RE = /&&|\|\||;|&|\||\n|\$\(|`|\)/

/**
 * RHS of every output redirection: `> f`, `>> f`, `>| f`, `2> f`, `&> f`,
 * quoted or bare. fd-dups (`>&1`) and process substitution (`>(cmd)`) do not
 * match because `&`/`(` are excluded from the target classes.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- safe-regex false positive: no nested unbounded quantifier, alternation branches disjoint by first char; ReDoS-audited linear (<1ms on 50k-char pathological input)
const REDIRECT_TARGET_RE = /(?:\d+|&)?>{1,2}\|?\s*("[^"]+"|'[^']+'|[^\s;|&<>()`]+)/g

/** Input redirections (`< f`, heredoc markers) — stripped before arg analysis. */
const INPUT_REDIRECT_RE = /<+\s*[^\s;|&<>()`]*/g

/** `VAR=value` env-prefix token. */
const ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Pass-through wrappers skipped when locating the segment's binary. */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'nice', 'stdbuf', 'xargs'])

/** Strip one layer of surrounding single/double quotes from a token. */
function unquote(tok: string): string {
    let t = tok
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
        t = t.slice(1, -1)
    }
    if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
        t = t.slice(1, -1)
    }
    return t
}

/** Basename of a path-like token (last `/`-separated component). */
function basenameOf(tok: string): string {
    const parts = tok.split('/')
    return parts[parts.length - 1] ?? tok
}

/** All non-flag args (the tee/rm/truncate rule). */
function nonFlagArgs(args: string[]): string[] {
    return args.filter((a) => !a.startsWith('-'))
}

/** cp/mv/install destination: the LAST positional arg + any -t/--target-directory value. */
function destArgs(args: string[]): string[] {
    const out: string[] = []
    const positional: string[] = []
    for (let i = 0; i < args.length; i++) {
        const a = nonNull(args[i])
        if (a === '-t' || a === '--target-directory') {
            const v = args[i + 1]
            if (v !== undefined) {
                out.push(v)
            }
            i++
        } else if (a.startsWith('--target-directory=')) {
            out.push(a.slice('--target-directory='.length))
        } else if (!a.startsWith('-')) {
            positional.push(a)
        }
    }
    const last = positional[positional.length - 1]
    if (last !== undefined) {
        out.push(last)
    }
    return out
}

/** sed/perl: every positional arg IF an in-place flag (-i, -pi, -i.bak, --in-place) is present. */
function inPlaceArgs(args: string[]): string[] {
    const inPlace = args.some((a) => a.startsWith('--in-place') || /^-[A-Za-z0-9.]*i/.test(a))
    return inPlace ? nonFlagArgs(args) : []
}

/**
 * Binary → which of its args are write targets. Deliberately small: the goal is
 * the common file-writing coreutils, not a full shell semantics model — nested
 * shells / eval / heredoc-into-sh are already denied by shell-bypass, and the
 * deny only ever fires when an extracted target canonicalizes to a TCB path.
 */
const WRITE_BINARIES: Record<string, (args: string[]) => string[]> = {
    tee: nonFlagArgs,
    rm: nonFlagArgs, // deleting a gate config / workflow neutralizes it as surely as rewriting it
    unlink: nonFlagArgs,
    truncate: nonFlagArgs,
    cp: destArgs,
    mv: destArgs,
    install: destArgs,
    dd: (args) => args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)),
    sed: inPlaceArgs,
    perl: inPlaceArgs,
}

/**
 * Extract every candidate WRITE target from a Bash command. Redirection targets
 * are scanned over the whole command (so they survive inside `$( … )` and the
 * segment split); binary destination args are resolved per compound segment,
 * skipping env-prefixes, wrappers (sudo/env/xargs/…), and leading flags.
 *
 * ponytail: token-level heuristic, not a shell parser — an exotic quoting/array
 * construction can evade it, but those forms are nested-shell territory
 * (shell-bypass) and the simple forms are exactly the reported bypass.
 */
export function bashWriteTargets(command: string): string[] {
    const out = new Set<string>()
    for (const m of command.matchAll(REDIRECT_TARGET_RE)) {
        out.add(unquote(nonNull(m[1])))
    }
    for (const seg of command.split(SEGMENT_SPLIT_RE)) {
        const cleaned = seg.replace(REDIRECT_TARGET_RE, ' ').replace(INPUT_REDIRECT_RE, ' ')
        const tokens = cleaned
            .split(/\s+/)
            .filter((t) => t.length > 0)
            .map(unquote)
        let i = 0
        while (i < tokens.length) {
            const tok = nonNull(tokens[i])
            if (!ENV_PREFIX_RE.test(tok) && !WRAPPERS.has(basenameOf(tok)) && !tok.startsWith('-')) {
                break
            }
            i++
        }
        const bin = i < tokens.length ? nonNull(tokens[i]) : undefined
        const rule = bin === undefined ? undefined : WRITE_BINARIES[basenameOf(bin)]
        if (rule) {
            for (const t of rule(tokens.slice(i + 1))) {
                out.add(t)
            }
        }
    }
    return [...out]
}

/** Options for {@link decideWriteProtection} (all injectable). */
export interface WriteProtectionDeps extends DataDirOptions {
    /** cwd for path canonicalization (defaults to process.cwd()). */
    cwd?: string
    /** Repo root for the `hooks/**` rule (defaults to cwd). */
    repoRoot?: string
}

/** Resolve the TCB context (data dir + repo root) for a check, best-effort. */
function resolveTcbContext(deps: WriteProtectionDeps): TcbContext {
    const cwd = deps.cwd ?? process.cwd()
    let dataDir: string | undefined
    try {
        dataDir = resolveDataDir(deps)
    } catch (err) {
        // resolveDataDir throws ONLY when CLAUDE_PLUGIN_DATA is unset — the data-dir TCB
        // rules (runs/**, specs/**) then can't apply, but the repo-relative rules (hooks/**,
        // dist/**) still do. Surface it rather than swallow: an UNEXPECTED resolver failure
        // must be detectable, mirroring holdout-guard's identical best-effort resolve.
        dataDir = undefined
        log.warn(
            `TCB data dir unresolved (${(err as Error).message}); ` +
                `data-dir write-protection rules are inert — repo-relative rules still apply`
        )
    }
    return {repoRoot: deps.repoRoot ?? cwd, dataDir}
}

/**
 * Decide whether a write tool invocation must be blocked for touching a TCB path.
 * Pure-ish (only reads the data dir via the Config seam for path resolution).
 * A MultiEdit is blocked if ANY of its targets is TCB-protected.
 */
export function decideWriteProtection(input: HookInput | null, deps: WriteProtectionDeps = {}): HookDecision {
    const tool = toolNameOf(input)
    const isBash = tool === 'Bash'
    if (!isBash && !WRITE_TOOLS.has(tool)) {
        return allow()
    }

    const targets = isBash ? bashWriteTargets(commandOf(input)) : filePathsOf(input)
    if (targets.length === 0) {
        return allow()
    }

    const ctx = resolveTcbContext(deps)
    const cwd = deps.cwd ?? process.cwd()

    for (const target of targets) {
        const match = isTcbProtected(target, ctx, cwd)
        if (match) {
            return deny(
                'tcb_write_denied',
                `${isBash ? 'Bash write' : tool} to TCB-protected path '${match.canonical}' is forbidden ` +
                    `(category=${match.rule.category}: ${match.rule.describe})`
            )
        }
    }
    return allow()
}

/**
 * Run the write-protection guard end-to-end: read+parse stdin, decide, emit the
 * permission-decision JSON on a deny, return the exit code. Malformed stdin fails
 * closed (deny). Injectable `readRaw` for tests.
 */
export async function runWriteProtection(
    _argv: string[] = [],
    deps: WriteProtectionDeps & {readRaw?: () => Promise<string>} = {}
): Promise<ExitCode> {
    let input: HookInput | null
    try {
        const raw = deps.readRaw ? await deps.readRaw() : await readAllStdin()
        input = parseHookInput(raw)
    } catch {
        const decision = deny('malformed_hook_input', 'write-protection: unparseable hook input')
        emitPermissionDecision(decision)
        return EXIT.ERROR
    }
    const decision = decideWriteProtection(input, deps)
    emitPermissionDecision(decision)
    return decisionToExitCode(decision)
}

/** Read all of process.stdin as utf-8. */
async function readAllStdin(): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array))
    }
    return Buffer.concat(chunks).toString('utf8')
}
