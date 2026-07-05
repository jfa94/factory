import {describe, expect, it} from 'vitest'
import {ensureStaging} from './staging.js'
import {FakeGitClient} from './fakes.js'

// Orchestrator worktree the runner enters (D2 fix): staging is materialised HERE,
// never by checking it out in the user's primary (main-dir) checkout.
const ORCH = '/repo/.claude/worktrees/orchestrator-run-test'

describe('staging-init / reconcile (isolated in the orchestrator worktree, never main)', () => {
    it('creates staging from base by adding the orchestrator worktree (main dir untouched)', async () => {
        const git = new FakeGitClient({remoteHeads: {develop: 'sha-dev-1'}})
        const r = await ensureStaging({gitClient: git, orchestratorWorktreePath: ORCH})
        expect(r.created).toBe(true)
        // staging pushed to origin from develop
        expect(git.getRemoteHead('staging')).toBeDefined()
        // materialised via `worktree add`, NOT `checkout -B` on the primary checkout
        expect(git.calls.some((c) => c.startsWith(`worktree add -b staging ${ORCH} origin/develop`))).toBe(true)
        expect(git.calls.some((c) => c.startsWith('checkout -B'))).toBe(false)
        // staging lives ONLY in the orchestrator worktree; the main dir's HEAD never moved
        expect(git.worktrees.get(ORCH)).toBe('staging')
        expect(await git.currentBranch()).toBe('main')
    })

    it('reuses an existing orchestrator worktree on resume (idempotent, no fatal re-add)', async () => {
        const git = new FakeGitClient({remoteHeads: {develop: 'sha-dev-1'}})
        // A prior create crashed after `worktree add` but before push → worktree + branch survive.
        git.worktrees.set(ORCH, 'staging')
        git.localBranches.set('staging', 'sha-old')
        const r = await ensureStaging({gitClient: git, orchestratorWorktreePath: ORCH})
        expect(r.created).toBe(true)
        // reused via ensureOnStaging's `checkout -B <branch> origin/base` IN the worktree,
        // never a bare `worktree add` (which fatals on the existing path/branch).
        expect(git.calls.some((c) => c.startsWith('checkout -B staging origin/develop'))).toBe(true)
        expect(git.calls.some((c) => c.startsWith('worktree add'))).toBe(false)
    })

    it('fails loud when the base branch does not exist (no main fallback)', async () => {
        const git = new FakeGitClient({remoteHeads: {}})
        await expect(ensureStaging({gitClient: git, orchestratorWorktreePath: ORCH})).rejects.toThrow(/base branch/i)
    })

    it("refuses a baseBranch of 'main'", async () => {
        const git = new FakeGitClient({remoteHeads: {main: 'x'}})
        await expect(
            ensureStaging({gitClient: git, baseBranch: 'main', orchestratorWorktreePath: ORCH})
        ).rejects.toThrow(/main/)
    })

    it('no-op when staging tip already equals base tip', async () => {
        const git = new FakeGitClient({remoteHeads: {develop: 'sha-1', staging: 'sha-1'}})
        const r = await ensureStaging({gitClient: git, orchestratorWorktreePath: ORCH})
        expect(r.created).toBe(false)
        expect(r.stagingTip).toBe('sha-1')
    })

    it('fast-forwards staging when base is strictly ahead (in the worktree, not main)', async () => {
        // merge-base(develop, staging) === staging tip → develop is ahead → FF.
        const git = new FakeGitClient()
        git.setRemoteHead('develop', 'sha-dev-2')
        git.setRemoteHead('staging', 'sha-stg-1')
        // make merge-base resolve to staging tip (staging is an ancestor of develop)
        git.mergeBase = () => Promise.resolve('sha-stg-1')
        const r = await ensureStaging({gitClient: git, orchestratorWorktreePath: ORCH})
        expect(r.created).toBe(false)
        expect(git.calls.some((c) => c.startsWith(`worktree add -b staging ${ORCH} origin/develop`))).toBe(true)
        expect(await git.currentBranch()).toBe('main')
    })

    it('leaves staging alone when it is ahead of base (normal mid-cycle)', async () => {
        const git = new FakeGitClient()
        git.setRemoteHead('develop', 'sha-dev-1')
        git.setRemoteHead('staging', 'sha-stg-2')
        git.mergeBase = () => Promise.resolve('sha-dev-1') // base is an ancestor of staging
        const r = await ensureStaging({gitClient: git, orchestratorWorktreePath: ORCH})
        expect(r.created).toBe(false)
        expect(r.stagingTip).toBe('sha-stg-2')
    })

    it('fails loud on divergence (no silent reconcile)', async () => {
        const git = new FakeGitClient()
        git.setRemoteHead('develop', 'sha-dev-1')
        git.setRemoteHead('staging', 'sha-stg-1')
        git.mergeBase = () => Promise.resolve('sha-ancestor-0') // neither is ancestor of the other
        await expect(ensureStaging({gitClient: git, orchestratorWorktreePath: ORCH})).rejects.toThrow(/DIVERGED/)
    })
})
