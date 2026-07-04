/**
 * Shared command-string validation for configured/contracted gate commands —
 * the SINGLE tokenizer + charset allowlist behind both the sast gate's
 * `quality.securityCommand` (src/verifier/deterministic/strategies/sast.ts) and
 * the gate contract's per-gate `command` override
 * (src/verifier/deterministic/gate-contract.ts). Extracted so the two callers
 * cannot drift (S7, Decision 46); each supplies its own RUNNER policy as a
 * predicate over the already-charset-validated argv.
 *
 * Zero-dependency leaf (gate-config-names.ts precedent) so it inlines cleanly
 * into any bundle.
 */

/** A token is safe iff it matches the allowlist charset (no shell metacharacters). */
export const SAFE_TOKEN = /^[A-Za-z0-9._/=:+-]+$/

/** Command validation outcome (charset + runner-policy allowlists). */
export type CommandValidation =
    | {readonly ok: true; readonly argv: readonly string[]}
    | {
          readonly ok: false
          readonly reason: 'unsafe_command' | 'unallowed_runner'
          readonly detail: string
      }

// Strip any path prefix from a command's first token (bash `${cmd_array[0]##*/}`),
// yielding the bare runner name policy predicates switch on. Line comments on
// purpose: the bash expansion contains `*/`, which terminates a block comment.
export function runnerName(argv: readonly string[]): string {
    const bin = argv[0] ?? ''
    return bin.includes('/') ? bin.slice(bin.lastIndexOf('/') + 1) : bin
}

/**
 * Validate a command string: whitespace-split into tokens, every token must match
 * {@link SAFE_TOKEN} (else "unsafe_command"), then the caller-supplied
 * `isAllowedRunner` policy judges the argv (else "unallowed_runner"). Pure.
 */
export function validateCommand(
    command: string,
    isAllowedRunner: (argv: readonly string[]) => boolean
): CommandValidation {
    const tokens = command.split(/\s+/).filter((t) => t.length > 0)
    for (const t of tokens) {
        if (!SAFE_TOKEN.test(t)) {
            return {ok: false, reason: 'unsafe_command', detail: `unsafe token '${t}'`}
        }
    }
    if (tokens[0] === undefined) {
        return {ok: false, reason: 'unsafe_command', detail: 'empty command'}
    }
    if (!isAllowedRunner(tokens)) {
        return {
            ok: false,
            reason: 'unallowed_runner',
            detail: `runner '${runnerName(tokens)}' not allowlisted`,
        }
    }
    return {ok: true, argv: tokens}
}
