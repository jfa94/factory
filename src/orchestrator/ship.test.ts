/**
 * WS10 — unit tests for shipTask.
 *
 * shipTask is the fully-deterministic ship phase: it pushes the task branch,
 * opens (or looks up) the PR idempotently, records branch + pr_number into
 * state, and (in `live` mode) serial-merges via MergeSerializer. All I/O is
 * injectable (FakeGitClient + FakeGhClient + real StateManager in a tmpdir).
 */
import {describe, it, expect, afterEach} from 'vitest'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {shipTask, type ShipDeps} from './ship.js'

import {nonNull} from '../shared/index.js'
import {defaultConfig} from '../config/schema.js'
import {parseSpecManifest} from '../spec/schema.js'
import type {SpecManifest} from '../spec/index.js'
import {StateManager} from '../core/state/manager.js'
import {FakeGitClient, FakeGhClient} from '../git/fakes.js'
import {makeFakeTools} from '../verifier/deterministic/fakes.js'
import {InMemoryHoldoutStore} from '../verifier/holdout/index.js'
import type {PhaseContext} from '../types/index.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeSpec(): SpecManifest {
    return parseSpecManifest({
        spec_id: '42-checkout',
        issue_number: 42,
        slug: 'checkout',
        repo: 'acme/widgets',
        generated_at: '2026-06-01T00:00:00.000Z',
        tasks: [
            {
                task_id: 't-1',
                title: 'implement checkout',
                description: 'add checkout flow',
                files: ['src/checkout.ts'],
                acceptance_criteria: ['a', 'b'],
                tests_to_write: ['covers a and b'],
                depends_on: [],
                risk_tier: 'medium',
                risk_rationale: 'moderate blast radius',
            },
        ],
    })
}

interface ShipFixture {
    deps: ShipDeps
    state: StateManager
    gh: FakeGhClient
    git: FakeGitClient
    dataDir: string
    ctx: PhaseContext
}

async function makeShipFixture(opts: {runId: string; shipMode?: 'live' | 'no-merge'}): Promise<ShipFixture> {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-ship-'))
    const state = new StateManager({
        dataDir,
        lock: {stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50},
    })
    const git = new FakeGitClient({
        remoteHeads: {staging: 'sha-staging'},
        localBranches: {[`factory/${opts.runId}/t-1`]: {sha: 'sha-task'}},
    })
    const gh = new FakeGhClient()

    await state.create({
        run_id: opts.runId,
        staging_branch: `staging-${opts.runId}`,
        spec: {repo: 'acme/widgets', spec_id: '42-checkout', issue_number: 42},
    })
    await state.update(opts.runId, (s) => ({
        ...s,
        tasks: {
            ...s.tasks,
            't-1': {
                task_id: 't-1',
                status: 'shipping' as const,
                phase: 'ship' as const,
                depends_on: [],
                risk_tier: 'medium' as const,
                escalation_rung: 0,
                reviewers: [],
                merge_resyncs: 0,
            },
        },
    }))

    const run = await state.read(opts.runId)
    const task = nonNull(run.tasks['t-1'])
    const ctx: PhaseContext = {run, task, attempt: 1}

    const deps: ShipDeps = {
        config: defaultConfig(),
        spec: makeSpec(),
        git,
        gh,
        tools: makeFakeTools(),
        holdout: new InMemoryHoldoutStore(),
        dataDir,
        // FakeGitClient never touches real fs — reusing dataDir avoids a 2nd mkdtemp.
        workDir: dataDir,
        owner: 'acme',
        repo: 'widgets',
        shipMode: opts.shipMode ?? 'no-merge',
        state,
    }

    return {deps, state, gh, git, dataDir, ctx}
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('shipTask', () => {
    const fixtures: string[] = []

    afterEach(async () => {
        for (const d of fixtures.splice(0)) {
            await rm(d, {recursive: true, force: true})
        }
    })

    it('ships task PRs against staging/<run-id> (no-merge mode)', async () => {
        const {deps, ctx, gh, dataDir} = await makeShipFixture({runId: 'run-A'})
        fixtures.push(dataDir)

        const result = await shipTask(deps, ctx)

        expect(result).toEqual({kind: 'task-terminal', outcome: {outcome: 'done'}})
        // PR was created with the per-run staging branch as base
        expect(gh.created).toHaveLength(1)
        expect(gh.created[0]?.base).toBe('staging-run-A')
    })

    it('ships task PRs against staging/<run-id> in live mode and serializer targets per-run branch', async () => {
        const {deps, ctx, gh, dataDir} = await makeShipFixture({runId: 'run-B', shipMode: 'live'})
        fixtures.push(dataDir)

        const result = await shipTask(deps, ctx)

        expect(result).toEqual({kind: 'task-terminal', outcome: {outcome: 'done'}})
        // PR base is the per-run staging branch
        expect(gh.created[0]?.base).toBe('staging-run-B')
        // Serializer executed a merge (confirms it reached the merge path with per-run branch)
        expect(gh.merges).toHaveLength(1)
        // The merged PR had base pointing at the per-run staging branch
        const mergedPr = gh.prs.get('factory/run-B/t-1')
        expect(mergedPr?.baseRefName).toBe('staging-run-B')
    })

    it('honors a DIVERGENT staging_branch pin for PR base + serializer (revert-to-recompute guard)', async () => {
        const {deps, ctx, gh, dataDir} = await makeShipFixture({runId: 'run-D', shipMode: 'live'})
        fixtures.push(dataDir)

        // Pin a branch that does NOT equal runStagingBranch("run-D") (= "staging-run-D").
        // A regression to recomputing from the run id would silently open AND
        // merge the PR against the WRONG branch; seeding a divergent pin makes the
        // assertion fail unless the pin is honored (the recompute-equal fixtures can't).
        const pinned = 'staging-LEGACY-run-D'
        const pinnedCtx: PhaseContext = {...ctx, run: {...ctx.run, staging_branch: pinned}}

        const result = await shipTask(deps, pinnedCtx)

        expect(result).toEqual({kind: 'task-terminal', outcome: {outcome: 'done'}})
        // PR base is the PINNED branch (not the "staging-run-D" recompute).
        expect(gh.created[0]?.base).toBe(pinned)
        // The serializer merged against the same pinned base.
        expect(gh.merges).toHaveLength(1)
        expect(gh.prs.get('factory/run-D/t-1')?.baseRefName).toBe(pinned)
    })

    it('records branch and pr_number in state after ship', async () => {
        const {deps, ctx, state, dataDir} = await makeShipFixture({runId: 'run-C'})
        fixtures.push(dataDir)

        await shipTask(deps, ctx)

        const run = await state.read('run-C')
        const task = nonNull(run.tasks['t-1'])
        expect(task.branch).toBe('factory/run-C/t-1')
        expect(task.pr_number).toBeGreaterThan(0)
    })

    // The rescue-reset wedge (systemic-failure finding): a reset task's preflight
    // re-roots the branch on a fresh staging tip while origin keeps the pre-rescue
    // commits, so the force-free push is deterministically rejected non-fast-forward
    // on every re-drive. The root-cause repair: delete the stale run-scoped remote
    // ref and retry ONCE.
    describe('non-fast-forward push recovery', () => {
        /** Rejects the first `rejectPushes` pushes with a real git non-FF message. */
        class NonFfGitClient extends FakeGitClient {
            pushAttempts = 0
            constructor(
                private readonly rejectPushes: number,
                opts: ConstructorParameters<typeof FakeGitClient>[0]
            ) {
                super(opts)
            }
            override async push(...args: Parameters<FakeGitClient['push']>): ReturnType<FakeGitClient['push']> {
                this.pushAttempts++
                if (this.pushAttempts <= this.rejectPushes) {
                    throw new Error(
                        `git push exited 1: ! [rejected] ${args[1]} -> ${args[1]} (non-fast-forward)\n` +
                            `hint: Updates were rejected because the tip of your current branch is behind`
                    )
                }
                return super.push(...args)
            }
        }

        function nonFfFixture(runId: string, rejectPushes: number) {
            const git = new NonFfGitClient(rejectPushes, {
                remoteHeads: {staging: 'sha-staging'},
                localBranches: {[`factory/${runId}/t-1`]: {sha: 'sha-task'}},
            })
            return git
        }

        it('deletes the stale remote ref and retries once — ship completes', async () => {
            const {deps, ctx, gh, dataDir} = await makeShipFixture({runId: 'run-E'})
            fixtures.push(dataDir)
            const git = nonFfFixture('run-E', 1)

            const result = await shipTask({...deps, git}, ctx)

            expect(result).toEqual({kind: 'task-terminal', outcome: {outcome: 'done'}})
            expect(gh.deletedBranches).toEqual(['factory/run-E/t-1'])
            expect(git.pushAttempts).toBe(2) // rejected once, retried once
            expect(gh.created).toHaveLength(1) // ship proceeded normally after recovery
        })

        it('fails the task (blocked-environmental) when the retry is also rejected — no infinite loop', async () => {
            const {deps, ctx, gh, dataDir} = await makeShipFixture({runId: 'run-F'})
            fixtures.push(dataDir)
            const git = nonFfFixture('run-F', 2)

            const result = await shipTask({...deps, git}, ctx)

            expect(result.kind).toBe('task-terminal')
            if (result.kind !== 'task-terminal') {
                throw new Error('expected task-terminal')
            }
            expect(result.outcome).toMatchObject({
                outcome: 'failed',
                failure_class: 'blocked-environmental',
            })
            if (result.outcome.outcome !== 'failed') {
                throw new Error('expected failed')
            }
            expect(result.outcome.reason).toContain('still rejected')
            expect(gh.deletedBranches).toEqual(['factory/run-F/t-1']) // deleted exactly once
            expect(git.pushAttempts).toBe(2) // ONE retry, never a loop
            expect(gh.created).toHaveLength(0) // never reached PR creation
        })

        it('a non-non-FF push failure (network, auth) rethrows untouched — never deletes the remote ref', async () => {
            const {deps, ctx, gh, dataDir} = await makeShipFixture({runId: 'run-G'})
            fixtures.push(dataDir)
            const git = new (class extends FakeGitClient {
                override push(): Promise<void> {
                    throw new Error('fatal: unable to access origin: connection refused')
                }
            })({remoteHeads: {staging: 'sha-staging'}})

            await expect(shipTask({...deps, git}, ctx)).rejects.toThrow('connection refused')
            expect(gh.deletedBranches).toEqual([]) // the repair is scoped to non-FF only
        })
    })
})
