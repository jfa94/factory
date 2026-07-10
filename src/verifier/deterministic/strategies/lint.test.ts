/**
 * WS6 — lint gate vectors. Covers the Δ applicability skip (no eslint binary / no
 * eslint config in the worktree ⇒ NOT APPLICABLE, never a fail), the run path
 * (exit 0 ⇒ pass; exit≠0 ⇒ fail-closed on findings), and fail-loud on truncation.
 */
import {describe, expect, it} from 'vitest'
import {defaultConfig, type Config} from '../../../config/schema.js'
import {FakeArgvRunner, FakeEslint, FakeFs, makeFakeTools, proc} from '../fakes.js'
import {GateContractSchema} from '../gate-contract.js'
import {validContract} from '../gate-contract.test.js'
import type {GateRan, GateSkip, StrategyContext} from '../strategy.js'
import type {GateTools} from '../tools.js'
import {ESLINT_BIN, lintStrategy} from './lint.js'

function ctx(tools: GateTools, config: Config = defaultConfig()): StrategyContext<GateTools> {
    return {runId: 'r', taskId: 't', worktree: '/wt', baseRef: 'staging', config, tools}
}

/** An fs probe reporting eslint fully set up (binary + a flat config present). */
function eslintSetUp(): FakeFs {
    return new FakeFs([ESLINT_BIN, 'eslint.config.mjs'])
}

describe('lintStrategy applicability (Δ skip)', () => {
    it('no eslint binary in the worktree → SKIP no-eslint-binary (not applicable)', async () => {
        const tools = makeFakeTools({fs: new FakeFs([])})
        const out = await lintStrategy.run(ctx(tools))
        expect(out.kind).toBe('skip')
        expect((out as GateSkip).reason).toBe('no-eslint-binary')
    })

    it('eslint binary present but NO config → SKIP no-eslint-config', async () => {
        const tools = makeFakeTools({fs: new FakeFs([ESLINT_BIN])})
        const out = await lintStrategy.run(ctx(tools))
        expect(out.kind).toBe('skip')
        expect((out as GateSkip).reason).toBe('no-eslint-config')
    })

    it('an absent gate does NOT invoke eslint (no run when not applicable)', async () => {
        const eslint = new FakeEslint(proc(1))
        const tools = makeFakeTools({fs: new FakeFs([]), eslint})
        await lintStrategy.run(ctx(tools))
        expect(eslint.calls).toHaveLength(0)
    })
})

describe('lintStrategy run path (applicable: binary + config present)', () => {
    it('eslint exit 0 → PASS', async () => {
        const tools = makeFakeTools({fs: eslintSetUp(), eslint: new FakeEslint(proc(0))})
        const out = await lintStrategy.run(ctx(tools))
        expect(out.kind).toBe('ran')
        expect((out as GateRan).evidence.observed).toBe(true)
    })

    it('eslint exit≠0 → fail-closed on findings', async () => {
        const tools = makeFakeTools({fs: eslintSetUp(), eslint: new FakeEslint(proc(1))})
        const out = await lintStrategy.run(ctx(tools))
        expect(out.kind).toBe('ran')
        expect((out as GateRan).evidence.observed).toBe(false)
    })

    it('runs eslint in the worktree cwd', async () => {
        const eslint = new FakeEslint(proc(0))
        const tools = makeFakeTools({fs: eslintSetUp(), eslint})
        await lintStrategy.run(ctx(tools))
        expect(eslint.calls).toEqual([{cwd: '/wt'}])
    })

    it('truncated eslint output → THROWS (never judge a clipped run)', async () => {
        const tools = makeFakeTools({
            fs: eslintSetUp(),
            eslint: new FakeEslint(proc(0, '', '', true)),
        })
        await expect(lintStrategy.run(ctx(tools))).rejects.toThrow(/truncated/i)
    })
})

describe('lintStrategy — contract command (S7, Decision 46)', () => {
    function denoContract() {
        const raw = validContract()
        raw.stack = 'deno'
        ;(raw.gates as Record<string, unknown>).lint = {contracted: true, command: 'deno lint'}
        return GateContractSchema.parse(raw)
    }

    it('contracted command replaces eslint — bin/config probes and eslint not consulted', async () => {
        const eslint = new FakeEslint(proc(1)) // would fail if called
        const command = new FakeArgvRunner(proc(0))
        const tools = makeFakeTools({fs: new FakeFs([]), eslint, command}) // no eslint at all
        const out = await lintStrategy.run({...ctx(tools), contract: denoContract()})
        expect(out.kind).toBe('ran')
        expect((out as GateRan).evidence.observed).toBe(true)
        expect((out as GateRan).evidence.detail).toContain('contract:deno lint')
        expect(command.calls).toEqual([['deno', 'lint']])
        expect(eslint.calls).toHaveLength(0)
    })

    it('contracted command exit≠0 → fail-closed', async () => {
        const command = new FakeArgvRunner(proc(1, '', 'x.ts:1 no-unused-vars'))
        const tools = makeFakeTools({fs: new FakeFs([]), command})
        const out = await lintStrategy.run({...ctx(tools), contract: denoContract()})
        expect(out.kind).toBe('ran')
        expect((out as GateRan).evidence.observed).toBe(false)
    })

    it('contract WITHOUT a lint command → probe/skip path unchanged', async () => {
        const command = new FakeArgvRunner(proc(0)) // would mask the skip if called
        const tools = makeFakeTools({fs: new FakeFs([]), command})
        const contract = GateContractSchema.parse(validContract()) // lint contracted, no command
        const out = await lintStrategy.run({...ctx(tools), contract})
        expect(out.kind).toBe('skip')
        expect((out as GateSkip).reason).toBe('no-eslint-binary')
        expect(command.calls).toHaveLength(0)
    })
})
