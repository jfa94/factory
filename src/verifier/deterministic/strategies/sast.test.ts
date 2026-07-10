/**
 * WS6 — SAST gate vectors. Ports bin/pipeline-security-gate: token + runner-prefix
 * allowlist rejection (unsafe_command / unallowed_runner), no-command skip,
 * pass/fail by exit code, securityAllowFailures non-blocking.
 */
import {describe, expect, it} from 'vitest'
import {defaultConfig, type Config} from '../../../config/schema.js'
import {FakeArgvRunner, makeFakeTools, proc} from '../fakes.js'
import type {GateRan, GateSkip, StrategyContext} from '../strategy.js'
import type {GateTools} from '../tools.js'
import {sastStrategy, validateSecurityCommand} from './sast.js'

function ctx(tools: GateTools, config: Config): StrategyContext<GateTools> {
    return {runId: 'r', taskId: 't', worktree: '/wt', baseRef: 'staging', config, tools}
}

function withSecurity(cmd: string | undefined, extra: Partial<Config['quality']> = {}): Config {
    const c = defaultConfig()
    if (cmd !== undefined) {
        c.quality.securityCommand = cmd
    }
    Object.assign(c.quality, extra)
    return c
}

describe('validateSecurityCommand (allowlist oracle)', () => {
    it('accepts allowlisted runners', () => {
        expect(validateSecurityCommand('semgrep --config auto').ok).toBe(true)
        expect(validateSecurityCommand('go test ./...').ok).toBe(true)
        expect(validateSecurityCommand('bundle exec rspec').ok).toBe(true)
        expect(validateSecurityCommand('/usr/bin/semgrep --json').ok).toBe(true)
    })

    it('rejects unsafe tokens (unsafe_command)', () => {
        const v = validateSecurityCommand('mock-semgrep;evil')
        expect(v.ok).toBe(false)
        if (!v.ok) {
            expect(v.reason).toBe('unsafe_command')
        }
    })

    it('rejects unallowed runner prefixes (unallowed_runner)', () => {
        const v = validateSecurityCommand('bash -c whoami')
        expect(v.ok).toBe(false)
        if (!v.ok) {
            expect(v.reason).toBe('unallowed_runner')
        }
    })

    it("go without 'test' subcommand is unallowed", () => {
        const v = validateSecurityCommand('go build ./...')
        expect(v.ok).toBe(false)
        if (!v.ok) {
            expect(v.reason).toBe('unallowed_runner')
        }
    })
})

describe('sastStrategy', () => {
    it('no securityCommand → SKIP (not fail)', async () => {
        const out = await sastStrategy.run(ctx(makeFakeTools(), withSecurity(undefined)))
        expect(out.kind).toBe('skip')
        expect((out as GateSkip).reason).toBe('no-security-command')
    })

    it('clean scan (exit 0) → pass', async () => {
        const tools = makeFakeTools({semgrep: new FakeArgvRunner(proc(0))})
        const out = await sastStrategy.run(ctx(tools, withSecurity('semgrep --config auto')))
        expect((out as GateRan).evidence.observed).toBe(true)
    })

    it('findings (exit 1) → fail', async () => {
        const tools = makeFakeTools({semgrep: new FakeArgvRunner(proc(1))})
        const out = await sastStrategy.run(ctx(tools, withSecurity('semgrep --config auto')))
        expect((out as GateRan).evidence.observed).toBe(false)
    })

    it('securityAllowFailures=true → findings non-blocking (observed true, noted)', async () => {
        const tools = makeFakeTools({semgrep: new FakeArgvRunner(proc(1))})
        const out = await sastStrategy.run(
            ctx(tools, withSecurity('semgrep --config auto', {securityAllowFailures: true}))
        )
        const ev = (out as GateRan).evidence
        expect(ev.observed).toBe(true)
        expect(ev.detail).toContain('non-blocking')
    })

    it('unsafe command → fail-closed with reason', async () => {
        const out = await sastStrategy.run(ctx(makeFakeTools(), withSecurity('bash;evil')))
        const ev = (out as GateRan).evidence
        expect(ev.observed).toBe(false)
        expect(ev.detail).toContain('unsafe_command')
    })

    it('truncated semgrep output → THROWS', async () => {
        const tools = makeFakeTools({semgrep: new FakeArgvRunner(proc(0, '', '', true))})
        await expect(sastStrategy.run(ctx(tools, withSecurity('semgrep --config auto')))).rejects.toThrow(/truncated/i)
    })

    // A secret echoed in the scanner's output must be scrubbed before it reaches the
    // persisted detail (Δ K, M14). The detail now carries the command OUTPUT, so
    // redaction is load-bearing rather than a no-op over `exit=N`.
    const SECRET = 'AKIA1234567890ABCDEF' // matches the aws-access-key-id pattern

    it('securityRedactFindings=true (default) → secret in scanner output is REDACTED in detail', async () => {
        const finding = `rule-id: hardcoded-credential\n  ${SECRET}`
        const tools = makeFakeTools({semgrep: new FakeArgvRunner(proc(1, finding))})
        const out = await sastStrategy.run(ctx(tools, withSecurity('semgrep --config auto')))
        const ev = (out as GateRan).evidence
        expect(ev.observed).toBe(false) // findings present (exit 1)
        expect(ev.detail).not.toContain(SECRET)
        expect(ev.detail).toContain('[REDACTED]')
    })

    it('securityRedactFindings=false → scanner output is surfaced VERBATIM (no scrub)', async () => {
        const finding = `rule-id: hardcoded-credential\n  ${SECRET}`
        const tools = makeFakeTools({semgrep: new FakeArgvRunner(proc(1, finding))})
        const out = await sastStrategy.run(
            ctx(tools, withSecurity('semgrep --config auto', {securityRedactFindings: false}))
        )
        const ev = (out as GateRan).evidence
        expect(ev.detail).toContain(SECRET)
    })
})
