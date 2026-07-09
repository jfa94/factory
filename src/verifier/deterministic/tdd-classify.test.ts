/**
 * WS6 — TDD classification vectors (Δ N). Ports bin/tests/tdd-gate.sh cases
 * 1/2/3/5/9/10/11 + merge B3a/B3b + docs-only F3 + zero-commits P5, exercising the
 * PURE deriveTddVerdict over the commit list the GitProbe would hand up.
 */
import {describe, expect, it} from 'vitest'
import {commit} from './fakes.js'
import {classifyCommit, deriveTddVerdict} from './tdd-classify.js'

describe('classifyCommit (Δ N)', () => {
    it('test-only when all files are tests', () => {
        expect(classifyCommit(['tests/x.test.ts'])).toBe('test-only')
    })
    it('impl when any file is non-test non-docs', () => {
        expect(classifyCommit(['src/x.ts'])).toBe('impl')
        expect(classifyCommit(['tests/x.test.ts', 'src/x.ts'])).toBe('impl')
    })
    it('docs-only is not impl (F3)', () => {
        expect(classifyCommit(['docs/foo.md', 'README.md'])).toBe('test-only')
    })
    it('empty when no files (--allow-empty)', () => {
        expect(classifyCommit([])).toBe('empty')
        expect(classifyCommit([''])).toBe('empty')
    })
})

describe('deriveTddVerdict (Δ N — ports tdd-gate cases)', () => {
    it('case1: test-only [task] precedes impl [task] → ok', () => {
        const v = deriveTddVerdict(
            [
                commit({sha: 'c1', files: ['tests/x.test.ts'], tagged: true}),
                commit({sha: 'c2', files: ['src/x.ts'], tagged: true}),
            ],
            false
        )
        expect(v.ok).toBe(true)
        expect(v.exempt).toBe(false)
        expect(v.violations).toEqual([])
    })

    it('case2: impl [task] with no preceding test → impl-without-preceding-test', () => {
        const v = deriveTddVerdict([commit({sha: 'c1', files: ['src/x.ts'], tagged: true})], false)
        expect(v.ok).toBe(false)
        expect(v.exempt).toBe(false)
        expect(v.violations).toEqual([{commit: 'c1', reason: 'impl-without-preceding-test'}])
    })

    it('case3: tests-only diff passes WITHOUT claiming exemption', () => {
        const v = deriveTddVerdict([commit({sha: 'c1', files: ['tests/x.test.ts'], tagged: true})], false)
        expect(v.ok).toBe(true)
        expect(v.exempt).toBe(false)
    })

    it('case4: exempt honored only when impl exists, marks exempt:true', () => {
        const v = deriveTddVerdict([commit({sha: 'c1', files: ['src/x.ts'], tagged: true})], true)
        expect(v.ok).toBe(true)
        expect(v.exempt).toBe(true)
    })

    it('case9/10: untagged impl is a violation even with a tagged test present', () => {
        const v = deriveTddVerdict(
            [
                commit({sha: 'c1', files: ['tests/x.test.ts'], tagged: true}),
                commit({sha: 'c2', files: ['src/x.ts'], tagged: false}),
            ],
            false
        )
        expect(v.ok).toBe(false)
        expect(v.violations[0]?.reason).toBe('impl-commit-untagged')
    })

    it('case11: a tagged --allow-empty commit does NOT satisfy test-only', () => {
        const v = deriveTddVerdict(
            [
                commit({sha: 'c1', files: [], tagged: true}), // empty placeholder
                commit({sha: 'c2', files: ['src/x.ts'], tagged: true}),
            ],
            false
        )
        expect(v.ok).toBe(false)
        expect(v.violations[0]?.reason).toBe('impl-without-preceding-test')
    })

    it('B3a: merge bringing only test files counts test-only (pass)', () => {
        const v = deriveTddVerdict(
            [
                commit({sha: 'm1', files: ['tests/foo_test.go'], tagged: true, parentCount: 2}),
                commit({sha: 'c2', files: ['pkg/foo.go'], tagged: true}),
            ],
            false
        )
        expect(v.ok).toBe(true)
    })

    it('B3b/case5: merge bringing impl files counts impl (fail)', () => {
        const v = deriveTddVerdict([commit({sha: 'm1', files: ['pkg/foo.go'], tagged: true, parentCount: 2})], false)
        expect(v.ok).toBe(false)
        expect(v.violations[0]?.reason).toBe('impl-without-preceding-test')
    })

    it('Issue #2: a tagged resync merge bringing impl passes — [test RED][impl][tagged sync-merge bringing impl]', () => {
        // Mirrors resyncTaskBranchOntoStaging's tagged `-m` merge commit landing on the
        // task branch tip after the real RED/impl pair. The preceding test-only commit
        // already satisfies TDD ordering, so the merge (classified `impl` by its
        // first-parent diff) is fine as long as it's tagged (Fix #2) — untagged would
        // trip impl-commit-untagged (case9/10).
        const v = deriveTddVerdict(
            [
                commit({sha: 'c1', files: ['tests/x.test.ts'], tagged: true}),
                commit({sha: 'c2', files: ['src/x.ts'], tagged: true}),
                commit({sha: 'm1', files: ['src/other-task.ts'], tagged: true, parentCount: 2}),
            ],
            false
        )
        expect(v.ok).toBe(true)
        expect(v.violations).toEqual([])
    })

    it('defective-test recovery: [test, impl, test, impl] (all tagged) passes — each impl has a preceding test', () => {
        // The test-defective retry replays the RED phase on the SAME task branch, so the
        // tip sees a doubled sequence. The first test-only commit satisfies every later
        // impl, so the recovery never trips impl-without-preceding-test.
        const v = deriveTddVerdict(
            [
                commit({sha: 'c1', files: ['tests/x.test.ts'], tagged: true}),
                commit({sha: 'c2', files: ['src/x.ts'], tagged: true}),
                commit({sha: 'c3', files: ['tests/x.test.ts'], tagged: true}),
                commit({sha: 'c4', files: ['src/x.ts'], tagged: true}),
            ],
            false
        )
        expect(v.ok).toBe(true)
        expect(v.violations).toEqual([])
    })

    it('F3: docs-only commit passes without a preceding test (no impl)', () => {
        const v = deriveTddVerdict([commit({sha: 'c1', files: ['docs/foo.md', 'README.md'], tagged: true})], false)
        expect(v.ok).toBe(true)
        expect(v.violations).toEqual([])
    })

    it('P5: zero commits in base..HEAD FAILS closed (not exempt)', () => {
        const v = deriveTddVerdict([], true) // exempt arg must NOT rescue an empty range
        expect(v.ok).toBe(false)
        expect(v.exempt).toBe(false)
    })
})
