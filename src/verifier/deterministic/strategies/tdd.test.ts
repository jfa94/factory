/**
 * WS6 — TDD strategy integration over the GitProbe (Δ N).
 *
 * Exercises the strategy wiring around the pure deriveTddVerdict:
 *  - base resolution: prefer origin/<base>, fall back to local <base>, else
 *    fail-closed base_ref_not_found;
 *  - the squashed-history NO-OP (single commit carrying test+impl) is a pass;
 *  - tip-SHA memoization serves a prior verdict WITHOUT re-running commits();
 *  - a commits() throw (diff-tree failure) PROPAGATES (fail-loud, never a pass);
 *  - tdd_exempt comes from the injected ExemptReader, never state.
 */
import {describe, expect, it} from 'vitest'
import {defaultConfig} from '../../../config/schema.js'
import {commit, FakeGitProbe, makeFakeTools} from '../fakes.js'
import {GateMemo} from '../memo.js'
import type {GateRan, StrategyContext} from '../strategy.js'
import type {CommitInfo, GateTools} from '../tools.js'
import {isSquashedHistory, tddStrategy} from './tdd.js'

function ctx(tools: GateTools, extra: Partial<StrategyContext<GateTools>> = {}): StrategyContext<GateTools> {
    return {
        runId: 'r',
        taskId: 't1',
        worktree: '/wt',
        baseRef: 'staging',
        config: defaultConfig(),
        tools,
        exemptReader: {isExempt: () => Promise.resolve(false)},
        ...extra,
    }
}

/** A probe with the given refs + commit list and a HEAD sha for memo keying. */
function gitWith(refs: Record<string, string>, commits: readonly CommitInfo[]): FakeGitProbe {
    return new FakeGitProbe({refs: {HEAD: 'tip-1', ...refs}, commits})
}

describe('isSquashedHistory', () => {
    it('single commit with BOTH test and impl is squashed', () => {
        expect(isSquashedHistory([['src/x.ts', 'tests/x.test.ts']])).toBe(true)
    })
    it('single impl-only or test-only commit is NOT squashed', () => {
        expect(isSquashedHistory([['src/x.ts']])).toBe(false)
        expect(isSquashedHistory([['tests/x.test.ts']])).toBe(false)
    })
    it('multiple commits are never squashed', () => {
        expect(isSquashedHistory([['tests/x.test.ts'], ['src/x.ts']])).toBe(false)
    })
})

describe('tddStrategy base resolution', () => {
    it('prefers origin/<base> when present', async () => {
        const tools = makeFakeTools({
            git: gitWith({'origin/staging': 'b'}, [
                commit({sha: 'c1', files: ['tests/x.test.ts'], tagged: true}),
                commit({sha: 'c2', files: ['src/x.ts'], tagged: true}),
            ]),
        })
        const out = await tddStrategy.run(ctx(tools))
        expect((out as GateRan).evidence.observed).toBe(true)
    })

    it('falls back to local <base> when origin/<base> is absent', async () => {
        const tools = makeFakeTools({
            git: gitWith({staging: 'b'}, [commit({sha: 'c1', files: ['tests/x.test.ts'], tagged: true})]),
        })
        const out = await tddStrategy.run(ctx(tools))
        expect((out as GateRan).evidence.observed).toBe(true)
    })

    it('base_ref_not_found ⇒ fail-closed', async () => {
        const tools = makeFakeTools({git: gitWith({}, [])})
        const out = await tddStrategy.run(ctx(tools))
        const ev = (out as GateRan).evidence
        expect(ev.observed).toBe(false)
        expect(ev.detail).toContain('base_ref_not_found')
    })
})

describe('tddStrategy squashed-history no-op', () => {
    it('a single test+impl commit on staging is a NO-OP pass', async () => {
        const tools = makeFakeTools({
            git: gitWith({'origin/staging': 'b'}, [
                commit({sha: 'sq', files: ['src/x.ts', 'tests/x.test.ts'], tagged: true}),
            ]),
        })
        const out = await tddStrategy.run(ctx(tools))
        const ev = (out as GateRan).evidence
        expect(ev.observed).toBe(true)
        expect(ev.detail).toContain('squashed')
    })
})

describe('tddStrategy tip-SHA memoization (Δ N)', () => {
    it('a second run on the SAME tip is served from memo without re-running commits()', async () => {
        let commitsCalls = 0
        const probe = new FakeGitProbe({
            refs: {HEAD: 'tip-1', 'origin/staging': 'b'},
            commits: [
                commit({sha: 'c1', files: ['tests/x.test.ts'], tagged: true}),
                commit({sha: 'c2', files: ['src/x.ts'], tagged: true}),
            ],
        })
        const orig = probe.commits.bind(probe)
        probe.commits = async (...a: Parameters<typeof orig>) => {
            commitsCalls += 1
            return orig(...a)
        }
        const tools = makeFakeTools({git: probe})
        const memo = new GateMemo()
        const first = await tddStrategy.run(ctx(tools, {memo}))
        const second = await tddStrategy.run(ctx(tools, {memo}))
        expect((first as GateRan).evidence.observed).toBe(true)
        expect((second as GateRan).evidence.observed).toBe(true)
        expect(commitsCalls).toBe(1) // second served from tip-SHA memo
    })

    it('two DIFFERENT tasks at the SAME tip do NOT share a memo entry (key includes taskId)', async () => {
        let commitsCalls = 0
        const probe = new FakeGitProbe({
            refs: {HEAD: 'tip-1', 'origin/staging': 'b'},
            commits: [
                commit({sha: 'c1', files: ['tests/x.test.ts'], tagged: true}),
                commit({sha: 'c2', files: ['src/x.ts'], tagged: true}),
            ],
        })
        const orig = probe.commits.bind(probe)
        probe.commits = async (...a: Parameters<typeof orig>) => {
            commitsCalls += 1
            return orig(...a)
        }
        const tools = makeFakeTools({git: probe})
        const memo = new GateMemo()
        await tddStrategy.run(ctx(tools, {memo, taskId: 't1'}))
        await tddStrategy.run(ctx(tools, {memo, taskId: 't2'}))
        // distinct taskIds → distinct keys → t2 is re-classified, not served t1's memo.
        expect(commitsCalls).toBe(2)
    })
})

describe('tddStrategy fail-loud', () => {
    it('a commits() (diff-tree) failure PROPAGATES — never a silent pass', async () => {
        const tools = makeFakeTools({
            git: new FakeGitProbe({
                refs: {HEAD: 'tip-1', 'origin/staging': 'b'},
                commitsThrow: 'diff-tree exploded',
            }),
        })
        await expect(tddStrategy.run(ctx(tools))).rejects.toThrow(/diff-tree exploded/)
    })
})

describe('tddStrategy exemption (from injected reader, not state)', () => {
    it('exempt reader rescues an impl-only branch, marked exempt', async () => {
        const tools = makeFakeTools({
            git: gitWith({'origin/staging': 'b'}, [commit({sha: 'c1', files: ['src/x.ts'], tagged: true})]),
        })
        const out = await tddStrategy.run(ctx(tools, {exemptReader: {isExempt: () => Promise.resolve(true)}}))
        const ev = (out as GateRan).evidence
        expect(ev.observed).toBe(true)
        expect(ev.detail).toContain('exempt')
    })
})
