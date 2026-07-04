import {describe, expect, it} from 'vitest'
import {assertBaseIsStagingTip, createTaskWorktree, ensureOnStaging, removeWorktree} from './worktree.js'
import {FakeGitClient} from './fakes.js'
import {at} from '../shared/index.js'

describe('D12 — worktree base semantics + fallback', () => {
    it('createTaskWorktree forks from origin/staging and assertBaseIsStagingTip passes when born on staging', async () => {
        const git = new FakeGitClient({remoteHeads: {staging: 'sha-staging-1'}})
        const wt = await createTaskWorktree({
            gitClient: git,
            runId: 'run-1',
            taskId: 't1',
            path: '/tmp/wt-1',
        })
        expect(wt.branch).toBe('factory/run-1/t1')
        expect(wt.startPoint).toBe('origin/staging')
        // worktree branch born on the staging tip → merge-base == staging tip.
        await expect(assertBaseIsStagingTip({gitClient: git, path: '/tmp/wt-1'})).resolves.toBeUndefined()
    })

    it('FAILS LOUD on base drift (worktree merge-base != staging tip)', async () => {
        const git = new FakeGitClient({remoteHeads: {staging: 'sha-staging-1'}})
        await createTaskWorktree({gitClient: git, runId: 'run-1', taskId: 't1', path: '/tmp/wt-2'})
        // Simulate staging advancing AFTER the worktree was born → drift.
        git.setRemoteHead('staging', 'sha-staging-2')
        await expect(assertBaseIsStagingTip({gitClient: git, path: '/tmp/wt-2'})).rejects.toThrow(/base drift/i)
    })

    it('is REPLAY-SAFE: a re-create on an existing worktree reuses it (checkout -B), no second `worktree add`', async () => {
        const git = new FakeGitClient({remoteHeads: {staging: 'sha-staging-1'}})
        const args = {gitClient: git, runId: 'run-1', taskId: 't1', path: '/tmp/wt-replay'}
        // First create registers the worktree (the normal preflight path).
        await createTaskWorktree(args)
        expect(git.worktrees.has('/tmp/wt-replay')).toBe(true)
        const addsBefore = git.calls.filter((c) => c.startsWith('worktree add')).length

        // Simulate a resume re-entering preflight after a mid-phase failure: a bare
        // `worktree add -b` would FATAL on the existing path. The re-create must REUSE
        // the worktree (checkout -B onto the staging tip) instead of wedging.
        const wt = await createTaskWorktree(args)

        expect(wt.branch).toBe('factory/run-1/t1')
        // Reuse path → NO second `worktree add`; a `checkout -B` re-point instead.
        expect(git.calls.filter((c) => c.startsWith('worktree add')).length).toBe(addsBefore)
        expect(git.calls).toContain('checkout -B factory/run-1/t1 origin/staging')
    })

    it('createTaskWorktree itself throws on drift injected before the assertion', async () => {
        const git = new FakeGitClient({remoteHeads: {staging: 'sha-staging-1'}})
        // Make worktreeAdd birth the branch on a stale sha rather than the tip.
        const origAdd = git.worktreeAdd.bind(git)
        git.worktreeAdd = async (args) => {
            await origAdd(args)
            const bIdx = args.indexOf('-b')
            if (bIdx >= 0) {
                git.localBranches.set(at(args, bIdx + 1), 'sha-stale-0')
            }
        }
        await expect(
            createTaskWorktree({gitClient: git, runId: 'run-1', taskId: 't1', path: '/tmp/wt-3'})
        ).rejects.toThrow(/base drift/i)
    })
})

describe('D12 — idempotent checkout -B fallback (ported independently of the settings knob)', () => {
    it('ensureOnStaging runs `checkout -B <branch> origin/staging` and is a no-op when already on staging', async () => {
        const git = new FakeGitClient({remoteHeads: {staging: 'sha-staging-1'}})
        const wt = await createTaskWorktree({
            gitClient: git,
            runId: 'run-1',
            taskId: 't1',
            path: '/tmp/wt-4',
        })
        const before = git.localBranches.get(wt.branch)

        await ensureOnStaging({gitClient: git, path: '/tmp/wt-4', branch: wt.branch})

        // checkout -B onto the same tip → branch tip unchanged (verified no-op).
        expect(git.localBranches.get(wt.branch)).toBe(before)
        expect(git.calls).toContain(`checkout -B ${wt.branch} origin/staging`)
    })

    it('ensureOnStaging is the safety net: re-points a branch born off staging onto the tip', async () => {
        const git = new FakeGitClient({remoteHeads: {staging: 'sha-staging-1'}})
        // A branch that exists on a stale base.
        git.localBranches.set('factory/run-1/t1', 'sha-stale-0')
        await ensureOnStaging({gitClient: git, path: '/tmp/wt-5', branch: 'factory/run-1/t1'})
        expect(git.localBranches.get('factory/run-1/t1')).toBe('sha-staging-1')
    })
})

describe('removeWorktree', () => {
    it('removes a worktree (graceful path)', async () => {
        const git = new FakeGitClient({remoteHeads: {staging: 'sha-staging-1'}})
        await createTaskWorktree({gitClient: git, runId: 'run-1', taskId: 't1', path: '/tmp/wt-6'})
        expect(git.worktrees.has('/tmp/wt-6')).toBe(true)
        await removeWorktree(git, '/tmp/wt-6')
        expect(git.worktrees.has('/tmp/wt-6')).toBe(false)
    })

    it('falls back to --force when graceful remove returns non-zero, throws if force also fails', async () => {
        const git = new FakeGitClient()
        let calls = 0
        git.worktreeRemove = (args) => {
            calls += 1
            // graceful (no --force) fails; --force succeeds
            return Promise.resolve(args.includes('--force') ? 0 : 1)
        }
        await expect(removeWorktree(git, '/tmp/wt-7')).resolves.toBeUndefined()
        expect(calls).toBe(2)

        const git2 = new FakeGitClient()
        git2.worktreeRemove = () => Promise.resolve(1) // both fail
        await expect(removeWorktree(git2, '/tmp/wt-8')).rejects.toThrow(/--force/)
    })
})
