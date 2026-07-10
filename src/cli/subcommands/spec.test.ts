/**
 * `factory spec <verb>` CLI dispatch: usage edges, the exit-code mapping, and
 * --repo auto-derivation. The spec-build cores (resolveSpec/gateSpec/storeSpec
 * envelope contracts) are tested directly in src/spec/build.test.ts.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {rm} from 'node:fs/promises'
import {specCommand, resolveSpecRepo, specExitCode, weeklyParkedPause, type SpecBuildEnvelope} from './spec.js'
import {EXIT} from '../../shared/exit-codes.js'
import {parseArgs} from '../args.js'
import {FakeGitClient} from '../../git/index.js'
import {StateManager} from '../../core/state/index.js'
import {makeTempDataDir} from '../test-fixtures.js'

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
    it('unspecifiable + spec-defect → EXIT.ERROR; every other envelope → EXIT.OK', () => {
        const unspecifiable: SpecBuildEnvelope = {
            kind: 'unspecifiable',
            repo: REPO,
            issue: 1,
            prd_path: '/scratch/prd.json',
            blockers: ['specifiability: body too short'],
        }
        expect(specExitCode(unspecifiable)).toBe(EXIT.ERROR)

        const specDefect: SpecBuildEnvelope = {
            kind: 'spec-defect',
            repo: REPO,
            issue: 1,
            source: 'review',
            iterations: 3,
            max_iterations: 3,
            reason: 'spec regeneration bound exhausted (3/3)',
            blockers: ['granularity too coarse'],
        }
        expect(specExitCode(specDefect)).toBe(EXIT.ERROR)

        const reuse: SpecBuildEnvelope = {
            kind: 'reuse',
            repo: REPO,
            issue: 1,
            pointer: {repo: REPO, spec_id: '1-x', issue_number: 1},
        }
        expect(specExitCode(reuse)).toBe(EXIT.OK)

        const pause: SpecBuildEnvelope = {
            kind: 'pause',
            repo: REPO,
            issue: 1,
            scope: '7d',
            reason: 'weekly window breached',
        }
        expect(specExitCode(pause)).toBe(EXIT.OK)
    })
})

// ---------------------------------------------------------------------------
// weeklyParkedPause — the --supersede weekly-parked pre-check (read-only)
// ---------------------------------------------------------------------------

describe('weeklyParkedPause (--supersede pre-check)', () => {
    // The helper reads $CLAUDE_PLUGIN_DATA via StateManager({}) — same env wiring
    // the production run() path uses.
    let dataDir: string
    let prevEnv: string | undefined

    const spec = {repo: REPO, spec_id: '123-email-login', issue_number: 123}

    beforeEach(async () => {
        dataDir = await makeTempDataDir('spec-parked-')
        prevEnv = process.env.CLAUDE_PLUGIN_DATA
        process.env.CLAUDE_PLUGIN_DATA = dataDir
    })

    afterEach(async () => {
        if (prevEnv === undefined) {
            delete process.env.CLAUDE_PLUGIN_DATA
        } else {
            process.env.CLAUDE_PLUGIN_DATA = prevEnv
        }
        await rm(dataDir, {recursive: true, force: true})
    })

    it('a weekly-parked run (suspended + 7d window) → pause envelope naming the run', async () => {
        const m = new StateManager({dataDir})
        await m.create({run_id: 'run-parked', staging_branch: 'staging-run-parked', spec})
        await m.update('run-parked', (s) => ({
            ...s,
            status: 'suspended' as const,
            quota: {binding_window: '7d' as const, resets_at_epoch: 1_900_000_000},
        }))

        const env = await weeklyParkedPause(REPO, 123)
        expect(env).toMatchObject({
            kind: 'pause',
            repo: REPO,
            issue: 123,
            scope: '7d',
            resets_at_epoch: 1_900_000_000,
        })
        expect(env?.kind === 'pause' && env.reason).toMatch(/run-parked.*ignore-quota/s)
    })

    it('a plain running run → null (normal supersede flow proceeds)', async () => {
        const m = new StateManager({dataDir})
        await m.create({run_id: 'run-live', staging_branch: 'staging-run-live', spec})

        expect(await weeklyParkedPause(REPO, 123)).toBeNull()
    })

    it('a 5h-paused run → null (only the 7d wall blocks supersede)', async () => {
        const m = new StateManager({dataDir})
        await m.create({run_id: 'run-paused', staging_branch: 'staging-run-paused', spec})
        await m.update('run-paused', (s) => ({
            ...s,
            status: 'paused' as const,
            quota: {binding_window: '5h' as const, resets_at_epoch: 1_900_000_000},
        }))

        expect(await weeklyParkedPause(REPO, 123)).toBeNull()
    })

    it('no active run for the issue → null', async () => {
        expect(await weeklyParkedPause(REPO, 123)).toBeNull()
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
