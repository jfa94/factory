import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {MergeSerializer} from './serial-writer.js'
import {FakeGhClient} from './fakes.js'
import type {PullRequest} from './gh-client.js'
import {captureStream} from '../cli/test-helpers.js'

function openPr(number: number, head: string, overrides: Partial<PullRequest> = {}): PullRequest {
    return {
        number,
        headRefName: head,
        baseRefName: 'staging',
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        ...overrides,
    }
}

describe('Δ L — serial writer (#1)', () => {
    let dataDir: string
    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'ws3-merge-'))
    })
    afterEach(async () => {
        await rm(dataDir, {recursive: true, force: true})
    })

    function serializer(gh: FakeGhClient): MergeSerializer {
        return new MergeSerializer({
            ghClient: gh,
            owner: 'fake',
            repo: 'repo',
            dataDir,
            // tight lock window so the test is fast
            lock: {stale: 5_000, retries: 200, retryMinTimeout: 1, retryMaxTimeout: 20},
        })
    }

    it('no race: two concurrent merge() calls run strictly one-at-a-time (non-overlapping critical sections)', async () => {
        const gh = new FakeGhClient({
            prs: [openPr(100, 'factory/run-1/t1'), openPr(101, 'factory/run-1/t2')],
        })

        let active = 0
        let maxConcurrent = 0
        // Instrument the critical section: increment on enter, hold briefly, the
        // merge body then mutates. If the app-level lock works, active is never > 1.
        gh.onMergeEnter = async () => {
            active += 1
            maxConcurrent = Math.max(maxConcurrent, active)
            await new Promise((r) => setTimeout(r, 15))
            active -= 1
        }

        const ser = serializer(gh)
        const [a, b] = await Promise.all([ser.merge(100), ser.merge(101)])

        expect(maxConcurrent).toBe(1) // strictly serial
        expect(a.merged).toBe(true)
        expect(b.merged).toBe(true)
        // Both merged via the app-level path, never armed concurrent --auto.
        expect(gh.merges.every((m) => !m.auto)).toBe(true)
        expect(gh.merges).toHaveLength(2)
    })

    it('up-to-date enforcement: a BEHIND PR is refused (not merged), no force-push/rebase-publish attempted', async () => {
        const gh = new FakeGhClient({
            prs: [openPr(200, 'factory/run-1/t1', {mergeStateStatus: 'BEHIND'})],
        })
        const ser = serializer(gh)
        const outcome = await ser.merge(200)

        expect(outcome).toEqual({merged: false, reason: 'behind', number: 200})
        expect(gh.merges).toHaveLength(0) // never merged
        // FakeGhClient/GitClient expose no force-push/rebase-publish method by
        // construction — nothing to call. Assert the merge action was not taken.
        expect(gh.calls.some((c) => c.startsWith('pr merge'))).toBe(false)
    })

    it('a CONFLICTING PR is refused as not-mergeable', async () => {
        const gh = new FakeGhClient({
            prs: [openPr(201, 'factory/run-1/t1', {mergeable: 'CONFLICTING'})],
        })
        const outcome = await serializer(gh).merge(201)
        expect(outcome).toEqual({merged: false, reason: 'not-mergeable', number: 201})
        expect(gh.merges).toHaveLength(0)
    })

    it('non-mergeable/pending merge states are REFUSED, not squashed (no wedge)', async () => {
        // Regression: merge() used to squash UNCONDITIONALLY once past the MERGED/
        // CONFLICTING/BEHIND guards. So BLOCKED (required checks pending), UNKNOWN
        // (mergeability still computing), DIRTY, and DRAFT threw ExecError out of
        // merge()→shipTask→next-action (which catches only UsageError) and WEDGED the
        // run on every drive. They must now refuse → ship turns it into a wait-retry.
        for (const state of ['BLOCKED', 'UNKNOWN', 'DIRTY', 'DRAFT'] as const) {
            const gh = new FakeGhClient({
                prs: [openPr(500, 'factory/run-1/t1', {mergeStateStatus: state})],
            })
            const outcome = await serializer(gh).merge(500)
            expect(outcome, state).toEqual({merged: false, reason: 'not-mergeable', number: 500})
            expect(gh.merges, state).toHaveLength(0) // never squashed
        }
    })

    it('genuinely-mergeable states beyond CLEAN (HAS_HOOKS, UNSTABLE) still squash — allowlist admits them', async () => {
        for (const [number, state] of [
            [510, 'HAS_HOOKS'],
            [511, 'UNSTABLE'],
        ] as const) {
            const gh = new FakeGhClient({prs: [openPr(number, 'factory/run-1/t1', {mergeStateStatus: state})]})
            const out = await serializer(gh).merge(number)
            expect(out, state).toEqual({merged: true, via: 'app-level', number})
            expect(gh.merges, state).toEqual([{number, auto: false, deleteBranch: false}])
        }
    })

    it('merge-queue probe upgrade: native support → enqueue via --auto; unsupported → app-level squash', async () => {
        // unsupported (default) → app-level
        const ghApp = new FakeGhClient({prs: [openPr(300, 'factory/run-1/t1')]})
        const appOut = await serializer(ghApp).merge(300)
        expect(appOut).toEqual({merged: true, via: 'app-level', number: 300})
        // App-level squash NEVER arms --delete-branch (worktree-safety, see below).
        expect(ghApp.merges).toEqual([{number: 300, auto: false, deleteBranch: false}])

        // native merge-queue present → --auto (GitHub serializes)
        const ghMq = new FakeGhClient({
            prs: [openPr(301, 'factory/run-1/t1')],
            protection: {
                staging: {
                    enabled: true,
                    requiredStatusChecks: ['ci'],
                    strictUpToDate: true,
                    hasMergeQueue: true,
                },
            },
        })
        const mqOut = await serializer(ghMq).merge(301)
        expect(mqOut).toEqual({merged: true, via: 'merge-queue', number: 301})
        // merge-queue defers the merge server-side, so --delete-branch is safe there
        // (GitHub deletes the head post-merge; no local `git branch -D` at enqueue).
        expect(ghMq.merges).toEqual([{number: 301, auto: true, deleteBranch: true}])
    })

    it('second merge re-verifies up-to-date against the post-first-merge staging tip (re-read inside lock)', async () => {
        // The 2nd PR is BEHIND. Even queued concurrently, the serializer re-reads it
        // inside the lock and refuses it — proving per-merge re-verification.
        const gh = new FakeGhClient({
            prs: [openPr(400, 'factory/run-1/t1'), openPr(401, 'factory/run-1/t2', {mergeStateStatus: 'BEHIND'})],
        })
        const ser = serializer(gh)
        const [a, b] = await Promise.all([ser.merge(400), ser.merge(401)])
        const first = a.number === 400 ? a : b
        const second = a.number === 401 ? a : b
        expect(first.merged).toBe(true)
        expect(second).toEqual({merged: false, reason: 'behind', number: 401})
    })

    it('worktree-safe: app-level merge deletes the REMOTE head ref, never --delete-branch', async () => {
        // Regression (CP2 #11): `gh pr merge --delete-branch` also runs `git branch -D`
        // on the local branch, which the per-task worktree holds checked-out, so the
        // delete — and the whole already-succeeded merge — failed (exit 1). The
        // serializer must squash WITHOUT --delete-branch, then delete only the remote ref.
        const gh = new FakeGhClient({prs: [openPr(310, 'factory/run-1/t1')]})
        const out = await serializer(gh).merge(310)
        expect(out).toEqual({merged: true, via: 'app-level', number: 310})
        expect(gh.merges).toEqual([{number: 310, auto: false, deleteBranch: false}])
        expect(gh.deletedBranches).toEqual(['factory/run-1/t1'])
    })

    it('idempotent resume: an already-MERGED PR returns success without re-merging', async () => {
        // Regression (CP2 #11): ship can crash after the merge lands but before the run
        // records `done`. Re-running drive (the sanctioned retry) re-enters merge(); a
        // MERGED PR must be treated as success — re-merging errors — and the remote-ref
        // cleanup the interrupted attempt skipped must still run (best-effort).
        const gh = new FakeGhClient({
            prs: [openPr(320, 'factory/run-1/t1', {state: 'MERGED'})],
        })
        const out = await serializer(gh).merge(320)
        expect(out).toEqual({merged: true, via: 'app-level', number: 320})
        expect(gh.merges).toHaveLength(0) // never re-merged
        expect(gh.deletedBranches).toEqual(['factory/run-1/t1'])
    })

    // -- WS7: post-merge remote-ref cleanup is BEST-EFFORT --------------------
    // The squash-merge has already landed; a failed head-ref delete is cosmetic
    // (a leaked branch), so it must be WARNED, never thrown — a throw here would
    // turn the success into an exception and, on retry, re-enter the MERGED path
    // and throw on the same delete again (a wedge). Distinct from the cancel
    // `--cleanup` path, where surfacing the failure loudly is the whole point.

    async function captureStderr<T>(fn: () => Promise<T>): Promise<{result: T; stderr: string}> {
        const saved = process.env.FACTORY_LOG_LEVEL
        process.env.FACTORY_LOG_LEVEL = 'info' // force warn-level through
        const cap = captureStream(process.stderr)
        try {
            const result = await fn()
            return {result, stderr: cap.read()}
        } finally {
            cap.restore()
            if (saved === undefined) {
                delete process.env.FACTORY_LOG_LEVEL
            } else {
                process.env.FACTORY_LOG_LEVEL = saved
            }
        }
    }

    it('a failed post-merge ref cleanup does NOT sink a fresh app-level merge (warns, returns merged)', async () => {
        const gh = new FakeGhClient({prs: [openPr(330, 'factory/run-1/t1')]})
        gh.failDeleteRemoteBranch = new Error('HTTP 500: server error')

        const {result, stderr} = await captureStderr(() => serializer(gh).merge(330))

        // The squash SUCCEEDED; a cosmetic leaked head ref must not turn it into a failure.
        expect(result).toEqual({merged: true, via: 'app-level', number: 330})
        expect(gh.merges).toEqual([{number: 330, auto: false, deleteBranch: false}])
        expect(gh.deletedBranches).toHaveLength(0) // delete threw → nothing recorded
        // LOUD, not silent: warned with the branch name so a leaked ref is detectable.
        expect(stderr).toMatch(/\[WARN\]/)
        expect(stderr).toContain('factory/run-1/t1')
    })

    it('a failed ref cleanup does NOT sink the idempotent-resume MERGED success (warns)', async () => {
        const gh = new FakeGhClient({
            prs: [openPr(331, 'factory/run-1/t2', {state: 'MERGED'})],
        })
        gh.failDeleteRemoteBranch = new Error('HTTP 500: server error')

        const {result, stderr} = await captureStderr(() => serializer(gh).merge(331))

        expect(result).toEqual({merged: true, via: 'app-level', number: 331})
        expect(gh.merges).toHaveLength(0) // never re-merged
        expect(gh.deletedBranches).toHaveLength(0)
        expect(stderr).toMatch(/\[WARN\]/)
        expect(stderr).toContain('factory/run-1/t2')
    })

    // -- Theme D1: a "couldn't tell" merge-queue probe must DEGRADE, not crash ----
    it('merge-queue probe failure degrades to app-level squash (warns, does NOT crash)', async () => {
        // The honest probe THROWS on a "couldn't tell" gh failure (auth/rate-limit/5xx).
        // merge() must CONTAIN it: log and fall back to app-level squash, never let the
        // throw escape — `factory next-action` catches only UsageError, so a bare throw would
        // WEDGE the run (results persisted but the phase re-throws on every retry).
        const gh = new FakeGhClient({prs: [openPr(340, 'factory/run-1/t1')]})
        gh.failMergeQueueProbe = new Error('HTTP 503: Service Unavailable')

        const {result, stderr} = await captureStderr(() => serializer(gh).merge(340))

        // Degraded to app-level squash — same squash, only --auto differs — head ref deleted.
        expect(result).toEqual({merged: true, via: 'app-level', number: 340})
        expect(gh.merges).toEqual([{number: 340, auto: false, deleteBranch: false}])
        expect(gh.deletedBranches).toEqual(['factory/run-1/t1'])
        // Observable, not silent: the probe failure is WARNED.
        expect(stderr).toMatch(/\[WARN\]/)
        expect(stderr).toMatch(/merge-queue probe failed/i)
    })
})
