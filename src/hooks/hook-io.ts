/**
 * WS9 — shared hook I/O + decision plumbing.
 *
 * Ports the bash deny/allow plumbing (`jq -r '.tool_input.command'`,
 * `{decision:"block",...}` / `permissionDecision:"deny"` JSON, exit-code
 * mapping) onto a typed, unit-testable surface. Every PreToolUse / SubagentStop
 * guard reads its input through {@link readHookInput} and returns a
 * {@link HookDecision}; the dispatcher maps that to an {@link ExitCode}.
 *
 * FAIL-CLOSED contract: malformed or empty stdin yields a DENY decision, never a
 * silent allow. (The bash hooks `exit 0` on empty input; here the *parse layer*
 * fails closed and the individual guard decides whether empty-equals-pass — see
 * each guard. `readHookInput` returns `null` for genuinely-empty input so a
 * guard can choose pass-through, and THROWS on malformed JSON so the dispatcher
 * fails closed.)
 */
import {EXIT, type ExitCode} from '../shared/exit-codes.js'
import {readStdin} from '../shared/stdin.js'

// readStdin now lives in shared/ (one-way dep: hooks→shared); re-exported here so
// existing hook call sites keep importing it from hook-io.
export {readStdin}

/**
 * Parsed PreToolUse / SubagentStop hook input. Claude Code passes a superset of
 * these fields; we type only what the guards consume and keep the rest open.
 */
export interface HookInput {
    /** Tool being invoked (PreToolUse): "Bash" | "Edit" | "Write" | "MultiEdit" | … */
    tool_name?: string
    /** Tool arguments. Shape depends on tool_name. */
    tool_input?: {
        /** Bash command string. */
        command?: string
        /** Edit/Write/MultiEdit single target. */
        file_path?: string
        /** MultiEdit per-edit targets. Elements are untrusted JSON — a nullable
         * element type is what makes the per-edit guard in filePathsOf load-bearing. */
        edits?: ({file_path?: string} | null)[]
        [k: string]: unknown
    }
    // SubagentStop fields.
    agent_type?: string
    subagent_type?: string
    last_assistant_message?: string
    agent_transcript_path?: string
    transcript_path?: string
    session_id?: string
    /** The invoking session's cwd (CC pipes it in every hook payload) — the repo
     * anchor for run resolution when no owner session id is present (Decision 61). */
    cwd?: string
    [k: string]: unknown
}

/** A guard's decision. `allow` lets the tool run; `deny` blocks it (reason logged). */
export type HookDecision =
    | {readonly action: 'allow'}
    | {readonly action: 'deny'; readonly reason: string; readonly detail?: string}

/** Build an allow decision. */
export function allow(): HookDecision {
    return {action: 'allow'}
}

/** Build a deny decision with a human-facing reason (+ optional detail). */
export function deny(reason: string, detail?: string): HookDecision {
    return detail === undefined ? {action: 'deny', reason} : {action: 'deny', reason, detail}
}

/** Type guard: is the decision a deny? */
export function isDeny(d: HookDecision): d is {action: 'deny'; reason: string; detail?: string} {
    return d.action === 'deny'
}

/** Thrown by {@link parseHookInput} on malformed JSON (the dispatcher fails closed). */
export class HookInputError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'HookInputError'
    }
}

/**
 * Parse a hook-input JSON string. Returns `null` for genuinely-empty input
 * (whitespace-only) so a guard can choose pass-through (matching the bash
 * `[[ -z "$input" ]] && exit 0`). THROWS {@link HookInputError} on non-empty but
 * malformed JSON — a corrupt payload must fail closed, never be silently allowed.
 */
export function parseHookInput(raw: string): HookInput | null {
    const trimmed = raw.trim()
    if (trimmed.length === 0) {
        return null
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(trimmed)
    } catch (err) {
        throw new HookInputError(`malformed hook input JSON: ${(err as Error).message}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new HookInputError('hook input must be a JSON object')
    }
    return parsed as HookInput
}

/**
 * Read + parse hook input from a stdin stream. Returns `null` for empty input.
 * Propagates {@link HookInputError} on malformed JSON (fail-closed at the call
 * site). Injectable stream for tests.
 */
export async function readHookInput(stream?: AsyncIterable<string | Uint8Array>): Promise<HookInput | null> {
    const raw = await readStdin(stream)
    return parseHookInput(raw)
}

/** Extract the Bash command from a hook input (empty string if absent). */
export function commandOf(input: HookInput | null): string {
    return input?.tool_input?.command ?? ''
}

/** Extract the tool name from a hook input (empty string if absent). */
export function toolNameOf(input: HookInput | null): string {
    return input?.tool_name ?? ''
}

/** Extract the session id from a hook input (undefined when absent or empty-string). */
export function sessionIdOf(input: HookInput | null): string | undefined {
    const v = input?.session_id
    return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Collect every file-path target from a tool input (Edit/Write `.file_path` plus
 * MultiEdit `.edits[].file_path`). De-duplicated, empties dropped. Used by the
 * write-protection + path-scope guards so a MultiEdit touching N files is
 * checked target-by-target.
 */
export function filePathsOf(input: HookInput | null): string[] {
    const ti = input?.tool_input
    if (!ti) {
        return []
    }
    const out: string[] = []
    if (typeof ti.file_path === 'string' && ti.file_path.length > 0) {
        out.push(ti.file_path)
    }
    if (Array.isArray(ti.edits)) {
        for (const e of ti.edits) {
            if (e && typeof e.file_path === 'string' && e.file_path.length > 0) {
                out.push(e.file_path)
            }
        }
    }
    return [...new Set(out)]
}

/**
 * Emit the Claude Code PreToolUse permission-decision JSON for a deny on stdout
 * (the `hookSpecificOutput.permissionDecision:"deny"` shape ported from
 * `pretooluse-pipeline-guards.sh`). No-op for an allow. Returns the JSON written
 * (or empty string) so tests can assert the shape without spying on stdout.
 */
export function emitPermissionDecision(
    decision: HookDecision,
    write: (s: string) => void = (s) => process.stdout.write(s)
): string {
    if (decision.action !== 'deny') {
        return ''
    }
    const reason =
        decision.detail != null && decision.detail.length > 0
            ? `${decision.reason}: ${decision.detail}`
            : decision.reason
    const payload = JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    })
    write(payload + '\n')
    return payload
}

/**
 * Emit the legacy `{decision:"block",reason,detail}` JSON on STDERR (the shape
 * the bash write-protection / branch-protection / secret-commit guards used).
 * Some guards still surface this form; kept for parity. No-op for an allow.
 */
export function emitBlockDecision(
    decision: HookDecision,
    write: (s: string) => void = (s) => process.stderr.write(s)
): string {
    if (decision.action !== 'deny') {
        return ''
    }
    const payload = JSON.stringify(
        decision.detail != null && decision.detail.length > 0
            ? {decision: 'block', reason: decision.reason, detail: decision.detail}
            : {decision: 'block', reason: decision.reason}
    )
    write(payload + '\n')
    return payload
}

/**
 * Emit the Claude Code SessionStart `additionalContext` JSON on stdout — the
 * harness contract for injecting text into a (re)started session's context.
 * Returns the JSON written so tests can assert the shape without spying on stdout.
 */
export function emitSessionStartContext(
    additionalContext: string,
    write: (s: string) => void = (s) => process.stdout.write(s)
): string {
    const payload = JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext,
        },
    })
    write(payload + '\n')
    return payload
}

/**
 * Map a {@link HookDecision} to a dispatcher {@link ExitCode}. A deny is a
 * blocking exit (Claude Code treats a non-zero PreToolUse exit, or the
 * permission-decision JSON, as a block); an allow is OK.
 *
 * We use {@link EXIT.ERROR} (1) for a deny so the dispatcher signals "blocked"
 * distinctly from a usage error (2). The permission-decision JSON on stdout is
 * the authoritative block signal for Claude Code; the exit code is the secondary
 * channel (bash hooks used exit 2 — but 2 is USAGE in our enum, reserved for the
 * dispatcher's own bad-args case, so a guard deny maps to ERROR).
 */
export function decisionToExitCode(decision: HookDecision): ExitCode {
    return decision.action === 'deny' ? EXIT.ERROR : EXIT.OK
}
