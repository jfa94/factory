/**
 * WS6 — security / SAST gate strategy.
 *
 * Ported from bin/pipeline-security-gate. Runs the configured
 * `quality.securityCommand` via the SemgrepTool, AFTER validating it against:
 *   - a TOKEN allowlist (each whitespace-split token must match
 *     `^[A-Za-z0-9._/=:+-]+$`; a `;`/space/etc. ⇒ reason "unsafe_command"); and
 *   - a RUNNER-PREFIX allowlist (semgrep/pytest/vitest/jest/mocha/phpunit/rspec,
 *     go|cargo|deno test, bundle exec rspec; else "unallowed_runner").
 *
 * No securityCommand ⇒ SKIP "no-security-command" (bash exit 2 / skip — never a
 * fail). observed = command exit 0. `securityAllowFailures` makes a non-zero exit
 * non-blocking (observed:true with a recorded note). `securityRedactFindings`
 * (default true) scrubs the captured stdout/stderr via the frozen redactSecrets
 * BEFORE the detail is surfaced/persisted (Δ K, M14).
 */
import {redactSecrets} from '../../../shared/index.js'
import {runnerName, validateCommand, type CommandValidation} from '../../../shared/command-allowlist.js'
import type {GateOutcome, GateStrategy, StrategyContext} from '../strategy.js'
import {ran, skip} from '../strategy.js'
import type {GateTools} from '../tools.js'

export type {CommandValidation}

/** The sast RUNNER policy over a charset-validated argv (bin/pipeline-security-gate:96-122). */
function isAllowedSecurityRunner(argv: readonly string[]): boolean {
    const runner = runnerName(argv)
    const a1 = argv[1]
    const a2 = argv[2]
    switch (runner) {
        case 'semgrep':
        case 'pytest':
        case 'vitest':
        case 'jest':
        case 'mocha':
        case 'phpunit':
        case 'rspec':
            return true
        case 'go':
        case 'cargo':
        case 'deno':
            return a1 === 'test'
        case 'bundle':
            return a1 === 'exec' && a2 === 'rspec'
        default:
            return false
    }
}

/**
 * Validate a configured security command string against the shared token
 * allowlist (src/shared/command-allowlist.ts) + the sast runner policy.
 * Pure — exported for unit vectors.
 */
export function validateSecurityCommand(command: string): CommandValidation {
    return validateCommand(command, isAllowedSecurityRunner)
}

export const sastStrategy: GateStrategy<GateTools> = {
    id: 'sast',
    async run(ctx: StrategyContext<GateTools>): Promise<GateOutcome> {
        const command = ctx.config.quality.securityCommand
        if (command === undefined || command.trim().length === 0) {
            return skip('sast', 'no-security-command')
        }
        const validation = validateSecurityCommand(command)
        if (!validation.ok) {
            // A misconfigured command FAILS the gate (fail-closed): observed:false.
            return ran('sast', false, `${validation.reason}: ${validation.detail}`)
        }
        const result = await ctx.tools.semgrep.run(validation.argv, {cwd: ctx.worktree})
        if (result.truncated) {
            throw new Error('sast gate: semgrep output truncated — refusing to parse a clipped payload')
        }
        // Surface the scanner's OUTPUT in the detail (this is what gets persisted), so
        // redaction is load-bearing: a finding that echoes a credential is scrubbed by
        // redactSecrets before it reaches the audit trail (Δ K, M14). Redacting only
        // `exit=N` (which never contains output) would be a no-op.
        const redact = ctx.config.quality.securityRedactFindings
        const rawOutput = `${result.stdout}\n${result.stderr}`.trim()
        const output = redact ? redactSecrets(rawOutput) : rawOutput
        const exit = `exit=${result.code ?? 'null'}`
        const detail = output.length > 0 ? `${exit} :: ${output}` : exit
        const clean = result.code === 0
        if (clean) {
            return ran('sast', true, `security ${detail}`)
        }
        if (ctx.config.quality.securityAllowFailures) {
            // Non-blocking: findings recorded but do not fail the conjunction (bash exit 0
            // with allow_failures, ok=false recorded). We mark observed:true so the merge gate
            // is not blocked, and name the non-blocking decision in the detail.
            return ran('sast', true, `security findings present but non-blocking (allowFailures) ${detail}`)
        }
        return ran('sast', false, `security findings present ${detail}`)
    },
}
