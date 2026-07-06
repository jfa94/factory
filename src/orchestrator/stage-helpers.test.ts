import {describe, expect, it, vi} from 'vitest'

import {FakeGitClient} from '../git/index.js'
import {ensureStageWorktree, publishToStaging, specTaskLines} from './stage-helpers.js'
import type {SpecManifest} from './deps.js'

describe('ensureStageWorktree — create/detach/reset/provision matrix', () => {
    it('absent + branch → worktree add -B <branch> <path> <ref>, provision runs', async () => {
        const git = new FakeGitClient()
        const provision = vi.fn().mockResolvedValue(undefined)
        await ensureStageWorktree(git, {
            worktree: '/wt/docs',
            ref: 'origin/staging-run-1',
            branch: 'docs-run-1',
            resetIfExists: true,
            provision,
        })
        expect(git.calls).toContain('worktree add -B docs-run-1 /wt/docs origin/staging-run-1')
        expect(provision).toHaveBeenCalledOnce()
        expect(git.calls.some((c) => c.startsWith('reset --hard'))).toBe(false)
    })

    it('absent + no branch → --detach checkout (read-only stages)', async () => {
        const git = new FakeGitClient()
        await ensureStageWorktree(git, {
            worktree: '/wt/trace',
            ref: 'origin/staging-run-1',
            resetIfExists: false,
        })
        expect(git.calls).toContain('worktree add --detach /wt/trace origin/staging-run-1')
    })

    it('present + resetIfExists → resetHardClean(ref) in the worktree, NO add, NO provision', async () => {
        const git = new FakeGitClient()
        const provision = vi.fn().mockResolvedValue(undefined)
        await ensureStageWorktree(git, {
            worktree: '/wt/docs',
            ref: 'origin/staging-run-1',
            branch: 'docs-run-1',
            resetIfExists: true,
            provision,
        })
        git.calls.length = 0
        provision.mockClear()
        await ensureStageWorktree(git, {
            worktree: '/wt/docs',
            ref: 'origin/staging-run-1',
            branch: 'docs-run-1',
            resetIfExists: true,
            provision,
        })
        expect(git.calls.some((c) => c.startsWith('worktree add'))).toBe(false)
        expect(git.calls.some((c) => c.includes('reset') || c.includes('hard'))).toBe(true)
        expect(provision).not.toHaveBeenCalled()
    })

    it('present + !resetIfExists → no git ops at all (reuse as-is)', async () => {
        const git = new FakeGitClient()
        await ensureStageWorktree(git, {worktree: '/wt/proof', ref: 'origin/main', branch: 'p', resetIfExists: false})
        git.calls.length = 0
        await ensureStageWorktree(git, {worktree: '/wt/proof', ref: 'origin/main', branch: 'p', resetIfExists: false})
        expect(git.calls.filter((c) => !c.startsWith('worktree exists'))).toEqual([])
    })
})

describe('publishToStaging', () => {
    it('ff-merges the branch into staging then pushes staging', async () => {
        const git = new FakeGitClient()
        await publishToStaging(git, 'staging-run-1', 'docs-run-1')
        expect(git.mergesInto['staging-run-1']).toEqual(['docs-run-1'])
        expect(git.calls).toContain('push origin staging-run-1')
    })
})

describe('specTaskLines', () => {
    it('renders one indented line per task with criteria joined by "; "', () => {
        const spec = {
            tasks: [
                {task_id: 'T1', title: 'Add slugify', acceptance_criteria: ['lowercases', 'strips symbols']},
                {task_id: 'T2', title: 'Wire CLI', acceptance_criteria: ['prints slug']},
            ],
        } as unknown as SpecManifest
        expect(specTaskLines(spec)).toBe(
            '  - T1 — Add slugify: lowercases; strips symbols\n  - T2 — Wire CLI: prints slug'
        )
    })
})
