import {describe, expect, it, vi} from 'vitest'
import {DefaultGitClient} from './git-client.js'
import {at, type ExecResult} from '../shared/index.js'
import type {GitRunner} from './exec-tools.js'

function result(over: Partial<ExecResult>): ExecResult {
    return {stdout: '', stderr: '', code: 0, signal: null, truncated: false, ...over}
}

describe('DefaultGitClient over an injectable runner (no real git)', () => {
    it('branchExists treats a code-1 show-ref miss as a normal NO (not an error)', async () => {
        const runner: GitRunner = (args) => {
            expect(args[0]).toBe('show-ref')
            return Promise.resolve(result({code: 1}))
        }
        const git = new DefaultGitClient(runner)
        await expect(git.branchExists('nope')).resolves.toBe(false)
    })

    it('branchExists returns true on code 0 and throws on code > 1', async () => {
        const yes = new DefaultGitClient(() => Promise.resolve(result({code: 0})))
        await expect(yes.branchExists('here')).resolves.toBe(true)
        const bad = new DefaultGitClient(() => Promise.resolve(result({code: 128, stderr: 'fatal'})))
        await expect(bad.branchExists('x')).rejects.toThrow(/show-ref/)
    })

    it('fetch/checkoutB/push are fatal on non-zero (execOrThrow)', async () => {
        const runner: GitRunner = () => Promise.resolve(result({code: 1, stderr: 'boom'}))
        const git = new DefaultGitClient(runner)
        await expect(git.fetch('origin', 'staging')).rejects.toThrow(/command failed/)
        await expect(git.checkoutB('b', 'origin/staging')).rejects.toThrow(/command failed/)
        await expect(git.push('origin', 'b')).rejects.toThrow(/command failed/)
    })

    it('push never passes a force flag (no force-push by construction)', async () => {
        const runner = vi.fn<GitRunner>(() => Promise.resolve(result({code: 0})))
        const git = new DefaultGitClient(runner)
        await git.push('origin', 'b', {setUpstream: true})
        const args = at(runner.mock.calls, 0)[0]
        expect(args).toEqual(['push', '-u', 'origin', 'b'])
        expect(args.some((a) => /force/i.test(a))).toBe(false)
    })

    it('lsRemoteHeads returns the sha or null on an empty result', async () => {
        const present = new DefaultGitClient(() => Promise.resolve(result({stdout: 'deadbeef\trefs/heads/staging\n'})))
        await expect(present.lsRemoteHeads('origin', 'staging')).resolves.toBe('deadbeef')
        const absent = new DefaultGitClient(() => Promise.resolve(result({stdout: ''})))
        await expect(absent.lsRemoteHeads('origin', 'nope')).resolves.toBeNull()
    })

    it('refExists treats code 0 as YES, code 1 as a normal NO, code > 1 as an error', async () => {
        const yes = new DefaultGitClient((args) => {
            expect(args).toEqual(['rev-parse', '--verify', '--quiet', 'origin/staging-run-1'])
            return Promise.resolve(result({code: 0, stdout: 'deadbeef\n'}))
        })
        await expect(yes.refExists('origin/staging-run-1')).resolves.toBe(true)
        const no = new DefaultGitClient(() => Promise.resolve(result({code: 1})))
        await expect(no.refExists('origin/gone')).resolves.toBe(false)
        const bad = new DefaultGitClient(() => Promise.resolve(result({code: 128, stderr: 'not a repo'})))
        await expect(bad.refExists('x')).rejects.toThrow(/rev-parse/)
    })

    it('isTracked treats code 0 as YES, code 1 as a normal NO, code > 1 as an error', async () => {
        const yes = new DefaultGitClient((args) => {
            expect(args).toEqual(['ls-files', '--error-unmatch', '--', '.factory/gates.json'])
            return Promise.resolve(result({code: 0, stdout: '.factory/gates.json\n'}))
        })
        await expect(yes.isTracked('.factory/gates.json')).resolves.toBe(true)
        const no = new DefaultGitClient(() => Promise.resolve(result({code: 1, stderr: 'did not match'})))
        await expect(no.isTracked('.factory/gates.json')).resolves.toBe(false)
        const bad = new DefaultGitClient(() => Promise.resolve(result({code: 128, stderr: 'not a repo'})))
        await expect(bad.isTracked('x')).rejects.toThrow(/ls-files/)
    })

    it('commitsAhead runs rev-list --count <base>..<branch> and parses the int', async () => {
        const git = new DefaultGitClient((args) => {
            expect(args).toEqual(['rev-list', '--count', 'origin/staging-run-1..factory/run-1/task-a'])
            return Promise.resolve(result({stdout: '3\n'}))
        })
        await expect(git.commitsAhead('origin/staging-run-1', 'factory/run-1/task-a')).resolves.toBe(3)
    })

    it('commitsAhead is fatal on non-zero and on non-numeric output', async () => {
        const failing = new DefaultGitClient(() => Promise.resolve(result({code: 128, stderr: 'bad rev'})))
        await expect(failing.commitsAhead('base', 'branch')).rejects.toThrow(/command failed/)
        const garbage = new DefaultGitClient(() => Promise.resolve(result({stdout: 'not-a-number\n'})))
        await expect(garbage.commitsAhead('base', 'branch')).rejects.toThrow(/non-numeric/)
    })

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

    it('mergeFfOrCommit checks out the branch then issues merge --no-edit <ref> (no force flag)', async () => {
        const calls: (readonly string[])[] = []
        const runner = vi.fn<GitRunner>((args) => {
            calls.push(args)
            return Promise.resolve(result({code: 0}))
        })
        const git = new DefaultGitClient(runner)
        await git.mergeFfOrCommit('staging/run-1', 'origin/develop')

        // First call: checkout branch
        expect(calls[0]).toEqual(['checkout', 'staging/run-1'])
        // Second call: merge --no-edit <ref> — no force flag anywhere
        expect(calls[1]).toEqual(['merge', '--no-edit', 'origin/develop'])
        expect(at(calls, 1).some((a) => /force/i.test(a) || a === '-f')).toBe(false)
    })

    it('mergeFfOrCommit is fatal on non-zero (merge conflict propagates)', async () => {
        const runner: GitRunner = (args) => {
            // checkout succeeds; merge fails (simulates a conflict)
            if (args[0] === 'merge') {
                return Promise.resolve(result({code: 1, stderr: 'CONFLICT'}))
            }
            return Promise.resolve(result({code: 0}))
        }
        const git = new DefaultGitClient(runner)
        await expect(git.mergeFfOrCommit('staging/run-1', 'origin/develop')).rejects.toThrow(/command failed/)
    })

    it('tryMergeNoForce returns {merged:true} on a clean merge (checkout, then merge --no-edit, no force)', async () => {
        const calls: (readonly string[])[] = []
        const runner = vi.fn<GitRunner>((args) => {
            calls.push(args)
            return Promise.resolve(result({code: 0}))
        })
        const git = new DefaultGitClient(runner)
        const r = await git.tryMergeNoForce('factory/run-1/T1', 'origin/staging-run-1')

        expect(r).toEqual({merged: true})
        expect(calls[0]).toEqual(['checkout', 'factory/run-1/T1'])
        expect(calls[1]).toEqual(['merge', '--no-edit', 'origin/staging-run-1'])
        expect(calls.flat().some((a) => /force/i.test(a) || a === '-f')).toBe(false)
    })

    it('tryMergeNoForce emits `git merge -m <message>` (no --no-edit) when opts.message is set', async () => {
        const calls: (readonly string[])[] = []
        const runner = vi.fn<GitRunner>((args) => {
            calls.push(args)
            return Promise.resolve(result({code: 0}))
        })
        const git = new DefaultGitClient(runner)
        const r = await git.tryMergeNoForce('factory/run-1/T1', 'origin/staging-run-1', {
            message: 'chore(sync): merge staging into task branch [T1]',
        })

        expect(r).toEqual({merged: true})
        expect(calls[1]).toEqual([
            'merge',
            '-m',
            'chore(sync): merge staging into task branch [T1]',
            'origin/staging-run-1',
        ])
    })

    it('tryMergeNoForce aborts to a clean tree and returns {merged:false, conflict} on conflict (does NOT throw)', async () => {
        const calls: (readonly string[])[] = []
        const runner: GitRunner = (args) => {
            calls.push(args)
            if (args[0] === 'merge' && args[1] === '--no-edit') {
                return Promise.resolve(result({code: 1, stderr: 'CONFLICT (content): merge conflict in a.ts'}))
            }
            return Promise.resolve(result({code: 0}))
        }
        const git = new DefaultGitClient(runner)
        const r = await git.tryMergeNoForce('factory/run-1/T1', 'origin/staging-run-1')

        expect(r.merged).toBe(false)
        if (r.merged) {
            throw new Error('unreachable')
        }
        expect(r.conflict).toMatch(/CONFLICT/)
        // The tree was aborted back to clean before returning.
        expect(calls.some((c) => c[0] === 'merge' && c[1] === '--abort')).toBe(true)
    })
})
