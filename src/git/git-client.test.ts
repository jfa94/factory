import {describe, expect, it} from 'vitest'
import {DefaultGitClient} from './git-client.js'
import type {ExecResult} from '../shared/index.js'

function result(over: Partial<ExecResult>): ExecResult {
    return {stdout: '', stderr: '', code: 0, signal: null, truncated: false, ...over}
}

describe('DefaultGitClient over an injectable runner (no real git)', () => {
    it('the public GitClient surface exposes no force-push method', () => {
        const git = new DefaultGitClient(() => Promise.resolve(result({code: 0})))
        expect((git as unknown as Record<string, unknown>).forcePush).toBeUndefined()
        expect((git as unknown as Record<string, unknown>).pushForce).toBeUndefined()
    })

    it('remoteUrl returns the trimmed url on success and null on a probe miss', async () => {
        const present = new DefaultGitClient((args) => {
            expect(args).toEqual(['remote', 'get-url', 'origin'])
            return Promise.resolve(result({stdout: 'git@github.com:acme/widgets.git\n'}))
        })
        await expect(present.remoteUrl('origin')).resolves.toBe('git@github.com:acme/widgets.git')
        // A non-zero exit (no such remote / not a git repo) is a normal NO, not a throw.
        const absent = new DefaultGitClient(() => Promise.resolve(result({code: 1, stderr: 'no such remote'})))
        await expect(absent.remoteUrl('origin')).resolves.toBeNull()
    })

    it('remoteUrl treats blank output as no url', async () => {
        const blank = new DefaultGitClient(() => Promise.resolve(result({stdout: '  \n'})))
        await expect(blank.remoteUrl('origin')).resolves.toBeNull()
    })

    it('remoteUrl runs in opts.cwd when given and the process cwd otherwise', async () => {
        const seen: unknown[] = []
        const git = new DefaultGitClient((_args, opts) => {
            seen.push(opts)
            return Promise.resolve(result({stdout: 'u\n'}))
        })
        await git.remoteUrl('origin', {cwd: '/repo'})
        await git.remoteUrl('origin', {cwd: ''})
        await git.remoteUrl('origin')
        expect(seen).toEqual([{cwd: '/repo'}, {}, {}])
    })
})
