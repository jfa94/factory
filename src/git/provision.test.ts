import {describe, expect, it} from 'vitest'
import {provisionWorktree, resolveSetupCommand} from './provision.js'

/** A fileExists predicate that returns true only for the named lockfile basenames. */
function lockfiles(...present: string[]): (abs: string) => Promise<boolean> {
    return (abs: string) => Promise.resolve(present.some((p) => abs.endsWith(p)))
}

describe('resolveSetupCommand', () => {
    it('explicit setupCommand wins over lockfile detection', async () => {
        const cmd = await resolveSetupCommand('/wt', 'make deps', lockfiles('package-lock.json'))
        expect(cmd).toBe('make deps')
    })

    it('detects `npm ci` from package-lock.json', async () => {
        expect(await resolveSetupCommand('/wt', undefined, lockfiles('package-lock.json'))).toBe('npm ci')
    })

    it('detects `npm ci` from npm-shrinkwrap.json', async () => {
        expect(await resolveSetupCommand('/wt', undefined, lockfiles('npm-shrinkwrap.json'))).toBe('npm ci')
    })

    it('detects pnpm from pnpm-lock.yaml', async () => {
        expect(await resolveSetupCommand('/wt', undefined, lockfiles('pnpm-lock.yaml'))).toBe(
            'pnpm install --frozen-lockfile'
        )
    })

    it('detects yarn from yarn.lock', async () => {
        expect(await resolveSetupCommand('/wt', undefined, lockfiles('yarn.lock'))).toBe(
            'yarn install --frozen-lockfile'
        )
    })

    it('returns null when no lockfile and no setupCommand (non-JS repo → no-op)', async () => {
        expect(await resolveSetupCommand('/wt', undefined, lockfiles())).toBeNull()
    })

    it('treats a blank setupCommand as unset (falls through to detection)', async () => {
        expect(await resolveSetupCommand('/wt', '   ', lockfiles('package-lock.json'))).toBe('npm ci')
    })
})

describe('provisionWorktree', () => {
    it('runs the resolved command in the worktree cwd', async () => {
        const calls: {command: string; cwd: string}[] = []
        await provisionWorktree({
            path: '/wt',
            fileExists: lockfiles('package-lock.json'),
            run: (command, cwd) => {
                calls.push({command, cwd})
                return Promise.resolve({code: 0, stderr: ''})
            },
        })
        expect(calls).toEqual([{command: 'npm ci', cwd: '/wt'}])
    })

    it('no-ops (never spawns) when there is nothing to install', async () => {
        let ran = false
        await provisionWorktree({
            path: '/wt',
            fileExists: lockfiles(),
            run: () => {
                ran = true
                return Promise.resolve({code: 0, stderr: ''})
            },
        })
        expect(ran).toBe(false)
    })

    it('FAILS LOUD when the setup command exits non-zero', async () => {
        await expect(
            provisionWorktree({
                path: '/wt',
                setupCommand: 'npm ci',
                run: () => Promise.resolve({code: 1, stderr: 'ENOENT lockfile'}),
            })
        ).rejects.toThrow(/provisioning failed.*npm ci.*exited 1/s)
    })

    it("surfaces the command's stderr in the failure message", async () => {
        await expect(
            provisionWorktree({
                path: '/wt',
                setupCommand: 'npm ci',
                run: () => Promise.resolve({code: 1, stderr: 'boom-detail'}),
            })
        ).rejects.toThrow(/boom-detail/)
    })
})
