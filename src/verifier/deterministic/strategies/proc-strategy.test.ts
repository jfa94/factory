/**
 * WS6 — `procOutcome` failing-gate detail enrichment (D5 fix-forward).
 *
 * Root cause this guards: a failing process gate (lint/tsc/build) collapsed its
 * detail to a bare `"<label> exit=<code>"` — the concrete stderr/stdout (the only
 * place the actual lint/type error text lives) was discarded before it ever reached
 * `mergeGateBlockReason` / the fix-forward pipeline. A passing gate's detail is
 * UNCHANGED (no excerpt needed — there is nothing to fix).
 */
import {describe, expect, it} from 'vitest'
import {defaultConfig} from '../../../config/schema.js'
import type {GateRan, StrategyContext} from '../strategy.js'
import {FakeBuild, FakeArgvRunner, FakeTsc, makeFakeTools, proc} from '../fakes.js'
import {GateContractSchema, type GateContract} from '../gate-contract.js'
import {validContract} from '../gate-contract.test.js'
import type {GateTools} from '../tools.js'
import {procOutcome} from './proc-strategy.js'
import {typeStrategy} from './type.js'
import {buildStrategy} from './build.js'

describe('procOutcome', () => {
    it("a passing gate keeps the plain '<label> exit=0' detail (no excerpt appended)", () => {
        const out = procOutcome('lint', 'eslint', proc(0, '', ''))
        expect(out.kind).toBe('ran')
        expect((out as GateRan).evidence.detail).toBe('eslint exit=0')
    })

    it('a failing gate appends a stderr excerpt to the detail (the T1 smoking gun)', () => {
        const out = procOutcome('lint', 'eslint', proc(1, '', 'src/lib/x.ts\n  10:5  error  no-unsafe-assignment'))
        expect(out.kind).toBe('ran')
        const detail = (out as GateRan).evidence.detail ?? ''
        expect(detail).toContain('eslint exit=1')
        expect(detail).toContain('no-unsafe-assignment')
    })

    it('falls back to stdout when stderr is empty', () => {
        const out = procOutcome('type', 'tsc', proc(1, 'src/a.ts(3,1): error TS2322', ''))
        const detail = (out as GateRan).evidence.detail ?? ''
        expect(detail).toContain('TS2322')
    })

    it('truncates an oversized excerpt (never blow up the prompt/state)', () => {
        const huge = 'x'.repeat(5000)
        const out = procOutcome('lint', 'eslint', proc(1, '', huge))
        const detail = (out as GateRan).evidence.detail ?? ''
        expect(detail.length).toBeLessThan(1200)
        expect(detail).toContain('truncated')
    })

    it('redacts a secret in the failing-gate stderr before it reaches the detail (public-comment sink)', () => {
        // Assembled at runtime so this source file carries no committable secret.
        const secret = 'AKIA' + 'IOSFODNN7EXAMPLE' // matches AKIA[0-9A-Z]{16}
        const out = procOutcome('build', 'npm run build', proc(1, '', `env dump: AWS_KEY=${secret}`))
        const detail = (out as GateRan).evidence.detail ?? ''
        expect(detail).toContain('npm run build exit=1')
        expect(detail).not.toContain(secret)
        expect(detail).toContain('[REDACTED]')
    })
})

describe('procStrategy — contract command (S7, Decision 46)', () => {
    function sctx(tools: GateTools, contract?: GateContract): StrategyContext<GateTools> {
        return {
            runId: 'r',
            taskId: 't',
            worktree: '/wt',
            baseRef: 'staging',
            config: defaultConfig(),
            tools,
            contract,
        }
    }

    function denoContract(): GateContract {
        const raw = validContract()
        raw.stack = 'deno'
        ;(raw.gates as Record<string, unknown>).type = {contracted: true, command: 'deno check .'}
        ;(raw.gates as Record<string, unknown>).build = {
            contracted: true,
            command: 'deno task build',
        }
        return GateContractSchema.parse(raw)
    }

    it('type: contracted `deno check .` replaces tsc', async () => {
        const tsc = new FakeTsc(proc(1)) // would fail if called
        const command = new FakeArgvRunner(proc(0))
        const tools = makeFakeTools({tsc, command})
        const out = await typeStrategy.run(sctx(tools, denoContract()))
        expect(out.kind).toBe('ran')
        expect((out as GateRan).evidence.observed).toBe(true)
        expect((out as GateRan).evidence.detail).toContain('contract:deno check .')
        expect(command.calls).toEqual([['deno', 'check', '.']])
        expect(tsc.calls).toHaveLength(0)
    })

    it('build: contracted `deno task build` replaces npm run build', async () => {
        const build = new FakeBuild(proc(1)) // would fail if called
        const command = new FakeArgvRunner(proc(0))
        const tools = makeFakeTools({build, command})
        const out = await buildStrategy.run(sctx(tools, denoContract()))
        expect((out as GateRan).evidence.observed).toBe(true)
        expect(command.calls).toEqual([['deno', 'task', 'build']])
        expect(build.calls).toHaveLength(0)
    })

    it('no contract → built-in tool path, CommandRunner untouched', async () => {
        const tsc = new FakeTsc(proc(0))
        const command = new FakeArgvRunner(proc(1)) // would fail if called
        const tools = makeFakeTools({tsc, command})
        const out = await typeStrategy.run(sctx(tools))
        expect((out as GateRan).evidence.observed).toBe(true)
        expect(tsc.calls).toHaveLength(1)
        expect(command.calls).toHaveLength(0)
    })
})
