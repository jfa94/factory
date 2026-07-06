/**
 * WS6 — GateRunner acceptance (D26 / Δ V derive-don't-store).
 *
 * Asserts the load-bearing invariants:
 *  - the verdict is DERIVED via deriveAllGatesVerdict over evidence, with no API to
 *    inject a stored "pass" (one failing gate ⇒ overall fail; all pass ⇒ pass);
 *  - an all-skipped / empty-evidence sweep FAILS closed (never default-open);
 *  - a strategy throw (truncated tool output) PROPAGATES — never swallowed to a pass;
 *  - ONE config drives every threshold (changing QualitySchema flips the verdict
 *    with the SAME tool outputs);
 *  - strategyFor is exhaustive over the closed GateId union.
 */
import {describe, expect, it} from 'vitest'
import {defaultConfig} from '../../config/schema.js'
import {GATE_IDS} from './strategy.js'
import {
    FakeCoverageTool,
    FakeEslint,
    FakeFs,
    FakeGitProbe,
    FakeStryker,
    FakeVitest,
    makeFakeTools,
    measured,
    proc,
    strykerResult,
} from './fakes.js'
import {GateRunner, strategyFor, type GateContext} from './gate-runner.js'
import type {GateContract, GateContractLoad} from './gate-contract.js'
import type {CoverageSummary, GateTools} from './tools.js'

const full: CoverageSummary = {lines: 100, branches: 100, functions: 100, statements: 100}

/** A git probe with origin/staging present, no changed files, a HEAD sha, no commits. */
function greenGit(extra: Record<string, string> = {}): FakeGitProbe {
    return new FakeGitProbe({
        refs: {'origin/staging': 'sha-base', HEAD: 'sha-head', ...extra},
        changedFiles: [],
        commits: [],
    })
}

/** greenGit + the base tree ref the coverage strategy resolves. */
function covGit(): FakeGitProbe {
    return greenGit({'origin/staging^{tree}': 'tree-base'})
}

/** Contract loader: everything waived except test+coverage (command-less). */
function loadsCoverageContract(overrides: Partial<GateContract['gates']> = {}): () => Promise<GateContractLoad> {
    const gates = Object.fromEntries(
        GATE_IDS.map((id) => [id, {contracted: false, reason: 'test-waived'}])
    ) as GateContract['gates']
    const contract: GateContract = {
        version: 1,
        stack: 'npm',
        gates: {...gates, test: {contracted: true}, coverage: {contracted: true}, ...overrides},
    }
    return () => Promise.resolve({state: 'ok', contract})
}

/** Default baseCtx loader: everything contracted (built-in commands) — a sweep never runs contract-less. */
function loadsAllContracted(): () => Promise<GateContractLoad> {
    const gates = Object.fromEntries(GATE_IDS.map((id) => [id, {contracted: true}])) as GateContract['gates']
    return () => Promise.resolve({state: 'ok', contract: {version: 1, stack: 'npm', gates}})
}

function baseCtx(tools: GateTools, gates: readonly (typeof GATE_IDS)[number][]): GateContext {
    return {
        runId: 'r1',
        taskId: 't1',
        worktree: '/wt',
        baseRef: 'staging',
        config: defaultConfig(),
        tools,
        gates,
        exemptReader: {isExempt: () => Promise.resolve(false)},
        loadContract: loadsAllContracted(),
    }
}

describe('strategyFor (closed union, exhaustive)', () => {
    it('resolves a strategy for every GATE_ID', () => {
        for (const id of GATE_IDS) {
            expect(strategyFor(id).id).toBe(id)
        }
    })

    it('throws (assertNever) on an unknown gate id', () => {
        // Bypass the type system to prove the runtime fail-loud branch exists.
        expect(() => strategyFor('bogus' as (typeof GATE_IDS)[number])).toThrow()
    })
})

describe("GateRunner — Δ V derive-don't-store conjunction", () => {
    it('all gates pass ⇒ DERIVED verdict passes, marked __derived', async () => {
        // test+tdd+type+lint+build only (coverage/mutation/sast need richer setup;
        // exercised in their own suites). All green tools ⇒ all observed:true.
        const tools = makeFakeTools({git: greenGit()})
        const res = await new GateRunner().run(baseCtx(tools, ['test', 'type', 'lint', 'build']))
        expect(res.verdict.passed).toBe(true)
        expect(res.verdict.__derived).toBe(true)
        expect(res.evidence.every((e) => e.observed)).toBe(true)
    })

    it('ONE failing gate flips the conjunctive verdict to fail', async () => {
        const tools = makeFakeTools({git: greenGit(), eslint: new FakeEslint(proc(1))})
        const res = await new GateRunner().run(baseCtx(tools, ['test', 'type', 'lint', 'build']))
        expect(res.verdict.passed).toBe(false)
    })

    it('empty evidence (all gates skipped) FAILS closed — never default-open', async () => {
        // sast waived by contract; run ONLY sast ⇒ zero evidence.
        const tools = makeFakeTools({git: greenGit()})
        const waived = Object.fromEntries(
            GATE_IDS.map((id) => [id, {contracted: false, reason: 'test-waived'}])
        ) as GateContract['gates']
        const res = await new GateRunner().run({
            ...baseCtx(tools, ['sast']),
            loadContract: () => Promise.resolve({state: 'ok', contract: {version: 1, stack: 'npm', gates: waived}}),
        })
        expect(res.evidence).toHaveLength(0)
        expect(res.skipped).toHaveLength(1)
        expect(res.verdict.passed).toBe(false) // deriveAllGatesVerdict([]) === false
    })

    it("a stored 'pass' cannot bypass re-derivation — verdict is computed each run", async () => {
        // Same tools, two runs: identical DERIVED verdicts, both carry __derived:true
        // (no field on the result lets a caller pre-seed a verdict).
        const tools = makeFakeTools({git: greenGit()})
        const runner = new GateRunner()
        const a = await runner.run(baseCtx(tools, ['test']))
        const b = await runner.run(baseCtx(tools, ['test']))
        expect(a.verdict.__derived).toBe(true)
        expect(b.verdict.__derived).toBe(true)
        expect(a.verdict.passed).toBe(b.verdict.passed)
    })
})

describe('GateRunner — gate contract (S7, Decision 46)', () => {
    /** A full 8-gate contract, everything waived except the overrides. */
    function contractWith(overrides: Partial<GateContract['gates']> = {}): GateContract {
        const gates = Object.fromEntries(
            GATE_IDS.map((id) => [id, {contracted: false, reason: 'test-waived'}])
        ) as GateContract['gates']
        return {version: 1, stack: 'npm', gates: {...gates, ...overrides}}
    }

    const loads = (contract: GateContract) => (): Promise<GateContractLoad> =>
        Promise.resolve({
            state: 'ok',
            contract,
        })

    it('a TOOLING skip on a CONTRACTED gate becomes a loud FAIL (contracted-but-unrunnable)', async () => {
        // lint contracted, but no eslint binary in the worktree → today's skip is
        // converted to failing evidence and the conjunction fails.
        const tools = makeFakeTools({git: greenGit(), fs: new FakeFs([])})
        const res = await new GateRunner().run({
            ...baseCtx(tools, ['lint']),
            loadContract: loads(contractWith({lint: {contracted: true}})),
        })
        expect(res.verdict.passed).toBe(false)
        expect(res.skipped).toHaveLength(0)
        expect(res.evidence).toHaveLength(1)
        expect(res.evidence[0]?.observed).toBe(false)
        expect(res.evidence[0]?.detail).toContain('contracted-but-unrunnable: no-eslint-binary')
    })

    it('a SCOPE skip on a CONTRACTED gate stays excluded (task property, not broken tooling)', async () => {
        // mutation contracted with stryker fully installed, but the diff has no
        // mutable changes → no-mutable-changes is a scope skip; the other gate's
        // green evidence carries the verdict.
        const tools = makeFakeTools({
            git: greenGit(),
            fs: new FakeFs(['node_modules/.bin/stryker', '.stryker.config.json']),
        })
        const res = await new GateRunner().run({
            ...baseCtx(tools, ['mutation', 'type']),
            loadContract: loads(contractWith({mutation: {contracted: true}, type: {contracted: true}})),
        })
        expect(res.skipped).toEqual([{gate: 'mutation', reason: 'no-mutable-changes'}])
        expect(res.verdict.passed).toBe(true)
    })

    it('an UNCONTRACTED gate skips cleanly WITHOUT invoking the strategy', async () => {
        const eslint = new FakeEslint(proc(0))
        const tools = makeFakeTools({git: greenGit(), eslint}) // fs all-present: probes would pass
        const res = await new GateRunner().run({
            ...baseCtx(tools, ['lint']),
            loadContract: loads(contractWith({lint: {contracted: false, reason: 'not opted in'}})),
        })
        expect(res.skipped).toEqual([{gate: 'lint', reason: 'uncontracted: not opted in'}])
        expect(eslint.calls).toHaveLength(0)
        expect(res.evidence).toHaveLength(0)
        // Empty evidence still fails closed — an all-uncontracted sweep never default-opens.
        expect(res.verdict.passed).toBe(false)
    })

    it('an ABSENT contract THROWS — a sweep never runs contract-less', async () => {
        const tools = makeFakeTools({git: greenGit(), fs: new FakeFs([])})
        await expect(
            new GateRunner().run({
                ...baseCtx(tools, ['lint']),
                loadContract: () => Promise.resolve({state: 'absent'}),
            })
        ).rejects.toThrow(/no \.factory\/gates\.json in this worktree.*factory scaffold/s)
    })

    it('an INVALID contract throws — never degrades to legacy', async () => {
        const tools = makeFakeTools({git: greenGit()})
        await expect(
            new GateRunner().run({
                ...baseCtx(tools, ['lint']),
                loadContract: () => Promise.resolve({state: 'invalid', error: 'gates.test: required'}),
            })
        ).rejects.toThrow(/INVALID.*gates\.test/)
    })
})

describe('GateRunner — fail-loud on truncation (never swallow to a pass)', () => {
    it('a truncated tool output throws OUT of the runner', async () => {
        const tools = makeFakeTools({
            git: greenGit(),
            vitest: new FakeVitest(proc(0, '', '', true)),
        })
        await expect(new GateRunner().run(baseCtx(tools, ['test']))).rejects.toThrow(/truncated/i)
    })
})

describe('GateRunner — ONE config drives every gate (Δ V)', () => {
    it('same tool outputs, different mutationScoreTarget ⇒ different verdict', async () => {
        const mkTools = (): GateTools =>
            makeFakeTools({
                git: new FakeGitProbe({
                    refs: {'origin/staging': 'sha-base', HEAD: 'sha-head'},
                    changedFiles: ['src/foo.ts'],
                }),
                stryker: new FakeStryker(strykerResult({code: 0, score: 75})),
            })

        const strict = defaultConfig()
        strict.quality.mutationScoreTarget = 80 // 75 < 80 → fail
        const lax = defaultConfig()
        lax.quality.mutationScoreTarget = 70 // 75 >= 70 → pass

        const runStrict = await new GateRunner().run({
            runId: 'r',
            taskId: 't',
            worktree: '/wt',
            baseRef: 'staging',
            config: strict,
            tools: mkTools(),
            gates: ['mutation'],
            loadContract: loadsAllContracted(),
        })
        const runLax = await new GateRunner().run({
            runId: 'r',
            taskId: 't',
            worktree: '/wt',
            baseRef: 'staging',
            config: lax,
            tools: mkTools(),
            gates: ['mutation'],
            loadContract: loadsAllContracted(),
        })

        expect(runStrict.verdict.passed).toBe(false)
        expect(runLax.verdict.passed).toBe(true)
    })

    it('coverage tolerance from config flips the verdict on identical measurements', async () => {
        const mkTools = (): GateTools =>
            makeFakeTools({
                git: covGit(),
                coverage: new FakeCoverageTool({
                    head: measured({lines: 97, branches: 100, functions: 100, statements: 100}), // -3
                    base: measured(full),
                }),
            })
        const strict = defaultConfig()
        strict.quality.coverageRegressionTolerancePct = 0.5 // -3 < -0.5 → fail
        const lax = defaultConfig()
        lax.quality.coverageRegressionTolerancePct = 5 // -3 within 5 → pass

        const s = await new GateRunner().run({
            runId: 'r',
            taskId: 't',
            worktree: '/wt',
            baseRef: 'staging',
            config: strict,
            tools: mkTools(),
            gates: ['coverage'],
            loadContract: loadsCoverageContract(),
        })
        const l = await new GateRunner().run({
            runId: 'r',
            taskId: 't',
            worktree: '/wt',
            baseRef: 'staging',
            config: lax,
            tools: mkTools(),
            gates: ['coverage'],
            loadContract: loadsCoverageContract(),
        })
        expect(s.verdict.passed).toBe(false)
        expect(l.verdict.passed).toBe(true)
    })
})

describe('GateRunner — coverage under the contract (S8)', () => {
    it('UNCONTRACTED coverage is an explicit waived skip — the tool is never invoked', async () => {
        const coverage = new FakeCoverageTool({head: measured(full), base: measured(full)})
        const res = await new GateRunner().run({
            ...baseCtx(makeFakeTools({git: covGit(), coverage}), ['coverage']),
            loadContract: loadsCoverageContract({
                coverage: {contracted: false, reason: 'waived via --waive coverage'},
            }),
        })
        expect(res.skipped).toEqual([{gate: 'coverage', reason: 'uncontracted: waived via --waive coverage'}])
        expect(coverage.measureCalls).toHaveLength(0)
        expect(coverage.baseCalls).toHaveLength(0)
        expect(res.evidence).toHaveLength(0)
    })

    it('an ABSENT contract THROWS before coverage is even invoked', async () => {
        const coverage = new FakeCoverageTool({head: measured(full), base: measured(full)})
        await expect(
            new GateRunner().run({
                ...baseCtx(makeFakeTools({git: covGit(), coverage}), ['coverage']),
                loadContract: () => Promise.resolve({state: 'absent'}),
            })
        ).rejects.toThrow(/no \.factory\/gates\.json in this worktree/)
        expect(coverage.measureCalls).toHaveLength(0)
    })
})
