/**
 * `factory spec <verb>` CLI dispatch: usage edges, the exit-code mapping, and
 * --repo auto-derivation. The spec-build cores (resolveSpec/gateSpec/storeSpec
 * envelope contracts) are tested directly in src/spec/build.test.ts.
 */
import {describe, it, expect} from 'vitest'
import {specCommand, resolveSpecRepo, specExitCode, type SpecBuildEnvelope} from './spec.js'
import {EXIT} from '../../shared/exit-codes.js'
import {parseArgs} from '../args.js'
import {FakeGitClient} from '../../git/index.js'

const REPO = 'owner/app'

describe('specCommand (dispatch)', () => {
    it('prints help and returns OK for --help', async () => {
        expect(await specCommand.run(['--help'])).toBe(EXIT.OK)
    })
    it('returns USAGE for an unknown action', async () => {
        expect(await specCommand.run(['bogus'])).toBe(EXIT.USAGE)
    })
    it('returns USAGE when the required --issue is missing (--repo is optional/auto-derived)', async () => {
        // `--issue` is validated FIRST and short-circuits to USAGE before --repo is
        // ever resolved, so this exercises the missing-issue edge specifically.
        expect(await specCommand.run(['resolve'])).toBe(EXIT.USAGE)
    })
    it('returns USAGE for a non-positive --issue', async () => {
        expect(await specCommand.run(['gate', '--repo', REPO, '--issue', '0'])).toBe(EXIT.USAGE)
    })
})

describe('specExitCode', () => {
    it('unspecifiable → EXIT.ERROR; every other envelope → EXIT.OK', () => {
        const unspecifiable: SpecBuildEnvelope = {
            kind: 'unspecifiable',
            repo: REPO,
            issue: 1,
            prd_path: '/scratch/prd.json',
            blockers: ['specifiability: body too short'],
        }
        expect(specExitCode(unspecifiable)).toBe(EXIT.ERROR)

        const reuse: SpecBuildEnvelope = {
            kind: 'reuse',
            repo: REPO,
            issue: 1,
            pointer: {repo: REPO, spec_id: '1-x', issue_number: 1},
        }
        expect(specExitCode(reuse)).toBe(EXIT.OK)
    })
})

// ---------------------------------------------------------------------------
// resolveSpecRepo — auto-derive --repo from the origin remote (Prompt G)
// ---------------------------------------------------------------------------

describe('resolveSpecRepo auto-derives --repo from the origin remote', () => {
    /** A FakeGitClient whose origin remote-url resolves to the given slug. */
    function gitWithOrigin(slug: string): FakeGitClient {
        const git = new FakeGitClient()
        git.setRemoteUrl('origin', `git@github.com:${slug}.git`)
        return git
    }

    /** Parse a spec argv tail (post-action) into the args resolveSpecRepo consumes. */
    function argsOf(...argv: string[]): ReturnType<typeof parseArgs> {
        return parseArgs(argv)
    }

    it('no --repo flag → derives the repo from origin', async () => {
        const repo = await resolveSpecRepo(argsOf('--issue', '123'), {
            gitClient: gitWithOrigin(REPO),
            cwd: '/wherever',
        })
        expect(repo).toBe(REPO)
    })

    it('an explicit --repo that MATCHES the origin (case-insensitively) wins as canonical', async () => {
        const repo = await resolveSpecRepo(argsOf('--repo', 'Owner/App', '--issue', '123'), {
            gitClient: gitWithOrigin(REPO),
            cwd: '/wherever',
        })
        expect(repo).toBe(REPO)
    })

    it('an explicit --repo that MISMATCHES the origin throws LOUD naming both', async () => {
        await expect(
            resolveSpecRepo(argsOf('--repo', 'owner/other', '--issue', '123'), {
                gitClient: gitWithOrigin(REPO),
                cwd: '/wherever',
            })
        ).rejects.toThrow(/owner\/other.*owner\/app|owner\/app.*owner\/other/s)
    })

    it('the mismatch is a UsageError (maps to EXIT.USAGE through the command wrapper)', async () => {
        await expect(
            resolveSpecRepo(argsOf('--repo', 'owner/other', '--issue', '123'), {
                gitClient: gitWithOrigin(REPO),
                cwd: '/wherever',
            })
        ).rejects.toMatchObject({isUsageError: true})
    })

    it('no --repo and no origin remote throws LOUD (cannot auto-derive)', async () => {
        await expect(
            resolveSpecRepo(argsOf('--issue', '123'), {
                gitClient: new FakeGitClient(), // no remotes configured
                cwd: '/wherever',
            })
        ).rejects.toThrow()
    })
})
