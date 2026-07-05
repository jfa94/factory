import {describe, expect, it} from 'vitest'
import {createTaskPrIdempotent} from './pr.js'
import {FakeGhClient} from './fakes.js'

describe('Δ P — idempotent PR create', () => {
    const baseArgs = {
        branch: 'factory/run-1/t1',
        title: 't1',
        body: 'body',
        base: 'staging',
    }

    it('returns the existing OPEN PR with resumed:true and NEVER calls prCreate (no duplicate)', async () => {
        const gh = new FakeGhClient({
            prs: [
                {
                    number: 42,
                    headRefName: 'factory/run-1/t1',
                    baseRefName: 'staging',
                    state: 'OPEN',
                    url: 'https://github.com/fake/repo/pull/42',
                },
            ],
        })

        const result = await createTaskPrIdempotent({ghClient: gh, ...baseArgs})

        expect(result).toEqual({
            number: 42,
            url: 'https://github.com/fake/repo/pull/42',
            resumed: true,
        })
        expect(gh.created).toHaveLength(0) // prCreate never invoked
    })

    it('creates a new PR when none exists (resumed:false)', async () => {
        const gh = new FakeGhClient()
        const result = await createTaskPrIdempotent({ghClient: gh, ...baseArgs})

        expect(result.resumed).toBe(false)
        expect(result.number).toBeGreaterThan(0)
        expect(gh.created).toHaveLength(1)
        expect(gh.created[0]?.head).toBe('factory/run-1/t1')
    })

    it('resume-after-kill: create succeeded but pr_number unrecorded → lookup-by-head re-binds the SAME number', async () => {
        const gh = new FakeGhClient()
        // First call simulates the create that succeeded before the kill.
        const first = await createTaskPrIdempotent({ghClient: gh, ...baseArgs})
        expect(first.resumed).toBe(false)

        // Orchestrator died before persisting pr_number; resume calls again with only the
        // branch known. The lookup-by-head path must re-bind the SAME PR.
        const resumed = await createTaskPrIdempotent({ghClient: gh, ...baseArgs})
        expect(resumed.resumed).toBe(true)
        expect(resumed.number).toBe(first.number)
        expect(gh.created).toHaveLength(1) // still only ONE create total
    })

    it('a CLOSED PR for the head does not count as resumable (opens a fresh PR)', async () => {
        const gh = new FakeGhClient({
            prs: [
                {
                    number: 7,
                    headRefName: 'factory/run-1/t1',
                    baseRefName: 'staging',
                    state: 'CLOSED',
                },
            ],
        })
        const result = await createTaskPrIdempotent({ghClient: gh, ...baseArgs})
        expect(result.resumed).toBe(false)
        expect(gh.created).toHaveLength(1)
    })

    it('post-merge-crash resume: a MERGED PR whose number state STILL remembers re-binds (no duplicate)', async () => {
        // Regression (CP2 #12): ship merged the PR but crashed before recording
        // `done` (the --delete-branch worktree failure). On resume, ship re-runs with
        // `pr_number` still persisted (written BEFORE the merge), so `knownPrNumber`
        // gates the MERGED fallback ON → lookup-by-head re-binds the SAME PR, NOT a
        // duplicate (the squashed branch diverged from staging). The serial-writer
        // merge step then idempotently no-ops.
        const gh = new FakeGhClient({
            prs: [
                {
                    number: 99,
                    headRefName: 'factory/run-1/t1',
                    baseRefName: 'staging',
                    state: 'MERGED',
                    url: 'https://github.com/fake/repo/pull/99',
                },
            ],
        })
        const result = await createTaskPrIdempotent({ghClient: gh, ...baseArgs, knownPrNumber: 99})
        expect(result).toEqual({
            number: 99,
            url: 'https://github.com/fake/repo/pull/99',
            resumed: true,
        })
        expect(gh.created).toHaveLength(0) // no duplicate opened
    })

    it('e2e-reopen: a MERGED PR is NOT rebound when state forgot the number → opens a FRESH PR', async () => {
        // Bug #2 (critical): e2e-reopen re-runs a `done` task with NEW commits on the
        // SAME deterministic branch; resetTaskRow(clearShippedPr) drops `pr_number` first,
        // so `knownPrNumber` is undefined. The old MERGED PR must NOT be rebound (the
        // serializer would no-op the reopened fix into oblivion) — a fresh PR opens for
        // the new commits.
        const gh = new FakeGhClient({
            prs: [
                {
                    number: 99,
                    headRefName: 'factory/run-1/t1',
                    baseRefName: 'staging',
                    state: 'MERGED',
                    url: 'https://github.com/fake/repo/pull/99',
                },
            ],
        })
        const result = await createTaskPrIdempotent({ghClient: gh, ...baseArgs}) // no knownPrNumber
        expect(result.resumed).toBe(false)
        expect(result.number).not.toBe(99)
        expect(gh.created).toHaveLength(1)
    })

    it('a MERGED PR whose number does NOT match knownPrNumber is not rebound (fresh PR)', async () => {
        // Defensive: if state remembers a DIFFERENT number than the merged PR sitting on
        // the head, that merged PR is not this task's resume target → open fresh.
        const gh = new FakeGhClient({
            prs: [
                {
                    number: 99,
                    headRefName: 'factory/run-1/t1',
                    baseRefName: 'staging',
                    state: 'MERGED',
                    url: 'https://github.com/fake/repo/pull/99',
                },
            ],
        })
        const result = await createTaskPrIdempotent({ghClient: gh, ...baseArgs, knownPrNumber: 7})
        expect(result.resumed).toBe(false)
        expect(gh.created).toHaveLength(1)
    })
})
