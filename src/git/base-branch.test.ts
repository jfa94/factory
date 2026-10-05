import {mkdtemp, mkdir, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach, describe, expect, it} from 'vitest'
import {execOrThrow} from '../shared/exec.js'
import {resolveBaseBranch} from './base-branch.js'

let dir = ''
afterEach(async () => {
    await rm(dir, {recursive: true, force: true})
})

/** A clone whose bare origin has `branches`, the first being the remote HEAD. */
async function cloneWith(branches: string[]): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'base-branch-'))
    const root = join(dir, 'repo'),
        remote = join(dir, 'remote.git')
    await mkdir(root)
    const git = (...args: string[]) => execOrThrow('git', args, {cwd: root})
    await git('init', '--bare', '-b', branches[0] ?? 'main', remote)
    await git('init', '-b', branches[0] ?? 'main')
    await git('-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '--allow-empty', '-m', 'init')
    await git('remote', 'add', 'origin', remote)
    for (const branch of branches) {
        await git('push', 'origin', `HEAD:refs/heads/${branch}`)
    }
    return root
}

describe('resolveBaseBranch (decision 8)', () => {
    it('unset with develop on the remote resolves to develop', async () => {
        const root = await cloneWith(['main', 'develop'])
        expect(await resolveBaseBranch(root, undefined)).toBe('develop')
    }, 30_000)

    it('unset without develop resolves to the remote default branch', async () => {
        const root = await cloneWith(['trunk', 'feature/develop'])
        expect(await resolveBaseBranch(root, undefined)).toBe('trunk')
    }, 30_000)

    it('uses an explicit branch that exists on the remote', async () => {
        const root = await cloneWith(['main', 'develop'])
        expect(await resolveBaseBranch(root, 'main')).toBe('main')
    }, 30_000)

    it('rejects an explicit branch missing from the remote, naming git.baseBranch', async () => {
        const root = await cloneWith(['main'])
        await expect(resolveBaseBranch(root, 'develop')).rejects.toThrow(/git\.baseBranch 'develop'/)
    }, 30_000)
})
