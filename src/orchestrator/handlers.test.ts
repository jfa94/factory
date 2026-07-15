/**
 * WS10 — unit tests for the PHASE HANDLERS (Model-A reporters).
 *
 * These exercise each reporter in ISOLATION (no runner loop): a handler reads a
 * frozen PhaseContext, does deterministic work via injected clients, and RETURNS a
 * PhaseResult — it never writes run state and never spawns. We drive the handlers
 * with the exported domain fakes (git/gh/gate/holdout) + a real StateManager (temp
 * dir) used ONLY to mint schema-valid RunState/TaskState contexts.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {makePhaseHandlers, specTaskOf, shipBody} from './handlers.js'
import {taskWorktreePath} from './paths.js'
import type {HandlerDeps} from './types.js'

import {defaultConfig} from '../config/schema.js'
import {parseSpecManifest} from '../spec/schema.js'
import type {SpecManifest} from '../spec/index.js'
import {StateManager} from '../core/state/manager.js'
import {FakeGitClient, FakeGhClient} from '../git/fakes.js'
import {
    contractedLoader,
    makeFakeTools,
    FakeGitProbe,
    FakeEslint,
    proc,
    commit,
} from '../verifier/deterministic/fakes.js'
import {InMemoryHoldoutStore, FsHoldoutVerdictStore, makeHoldoutRecord} from '../verifier/holdout/index.js'
import {dialForRung} from '../producer/index.js'
import {selectProducerModel} from '../quota/index.js'
import {PANEL_ROLES} from '../verifier/judgment/index.js'
import type {ReviewerResult, PhaseContext, TaskState} from '../types/index.js'
import {nonNull, at} from '../shared/index.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const RUN_ID = 'run-1'

/** A spec with three shaped tasks: holdout-active, holdout-skip, tdd-exempt. */
function makeSpec(): SpecManifest {
    return parseSpecManifest({
        spec_id: '42-checkout',
        issue_number: 42,
        slug: 'checkout',
        repo: 'acme/widgets',
        generated_at: '2026-06-01T00:00:00.000Z',
        tasks: [
            {
                task_id: 't-multi',
                title: 'multi-criteria task',
                description: 'holdout is active (>=2 criteria)',
                files: ['src/multi.tsx'],
                acceptance_criteria: ['a', 'b', 'c', 'd', 'e'],
                tests_to_write: ['covers a..e'],
                depends_on: [],
                risk_tier: 'medium',
                risk_rationale: 'moderate blast radius',
            },
            {
                task_id: 't-single',
                title: 'single-criterion task',
                description: 'holdout is skipped (1 criterion)',
                files: ['src/single.ts'],
                acceptance_criteria: ['only one'],
                tests_to_write: ['covers the one'],
                depends_on: [],
                risk_tier: 'low',
                risk_rationale: 'tiny change',
            },
            {
                task_id: 't-exempt',
                title: 'tdd-exempt task',
                description: 'skips the test-writer',
                files: ['src/exempt.ts'],
                acceptance_criteria: ['x', 'y', 'z'],
                tests_to_write: ['covers x..z'],
                depends_on: [],
                risk_tier: 'high',
                risk_rationale: 'exotic runner',
                tdd_exempt: true,
            },
        ],
    })
}

/** Extract the "- <criterion>" lines under the inlined prompt's "Acceptance criteria:" heading. */
function criteriaFromPrompt(prompt: string): string[] {
    const after = prompt.split('Acceptance criteria:\n')[1] ?? ''
    const section = after.split('\n\n')[0] ?? ''
    return section.split('\n').filter((l) => l.startsWith('- '))
}

/** A git probe whose full default gate sweep is GREEN (TDD-valid history). */
function greenProbe(): FakeGitProbe {
    return new FakeGitProbe({
        // The verify gate passes baseRef: "staging-run-1" (the per-run branch), so
        // the TDD strategy resolves "origin/staging-run-1".
        refs: {'origin/staging-run-1': 'sha-base', HEAD: 'sha-head'},
        changedFiles: [],
        commits: [
            commit({sha: 'c1', files: ['src/x.test.ts'], tagged: true}),
            commit({sha: 'c2', files: ['src/x.ts'], tagged: true}),
        ],
    })
}

describe('makePhaseHandlers (Model-A reporters)', () => {
    let dataDir: string
    let workDir: string
    let state: StateManager
    let holdout: InMemoryHoldoutStore
    let git: FakeGitClient
    let gh: FakeGhClient

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'factory-handlers-'))
        workDir = await mkdtemp(join(tmpdir(), 'factory-handlers-workdir-'))
        state = new StateManager({
            dataDir,
            lock: {stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50},
        })
        holdout = new InMemoryHoldoutStore()
        git = new FakeGitClient({remoteHeads: {'staging-run-1': 'sha-staging'}})
        gh = new FakeGhClient()
        await state.create({
            run_id: RUN_ID,
            staging_branch: `staging-${RUN_ID}`,
            spec: {repo: 'acme/widgets', spec_id: '42-checkout', issue_number: 42},
        })
    })

    afterEach(async () => {
        await rm(dataDir, {recursive: true, force: true})
        await rm(workDir, {recursive: true, force: true})
    })

    /** Seed a single task and return the frozen PhaseContext the engine would hand a reporter. */
    async function ctxFor(task: Partial<TaskState> & {task_id: string}): Promise<PhaseContext> {
        const full: TaskState = {
            task_id: task.task_id,
            status: task.status ?? 'pending',
            depends_on: task.depends_on ?? [],
            escalation_rung: task.escalation_rung ?? 0,
            reviewers: task.reviewers ?? [],
            merge_resyncs: task.merge_resyncs ?? 0,
            ...(task.test_revision_feedback != null && task.test_revision_feedback.length > 0
                ? {test_revision_feedback: task.test_revision_feedback}
                : {}),
            ...(task.e2e_feedback != null && task.e2e_feedback.length > 0 ? {e2e_feedback: task.e2e_feedback} : {}),
            ...(task.fix_findings ? {fix_findings: task.fix_findings} : {}),
        }
        await state.update(RUN_ID, (s) => ({...s, tasks: {...s.tasks, [full.task_id]: full}}))
        const run = await state.read(RUN_ID)
        const stored = nonNull(run.tasks[full.task_id])
        return {run, task: stored, attempt: stored.escalation_rung + 1}
    }

    /**
     * A FULL approving risk-invariant panel (every PANEL_ROLES role). The verify fast-path
     * now requires the complete panel on record before deriving the merge gate (fail-closed
     * against a persisted subset), so fast-path tests must seed all four, matching what a
     * sanctioned record (enforcePanelRoster) always persists.
     */
    function approvingPanel(): ReviewerResult[] {
        return PANEL_ROLES.map((role) => ({reviewer: role, verdict: 'approve' as const, confirmed_blockers: 0}))
    }

    function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
        return {
            config: defaultConfig(),
            spec: makeSpec(),
            git,
            gh,
            tools: makeFakeTools({git: greenProbe()}),
            loadContract: contractedLoader({
                coverage: {contracted: false, reason: 'fixture: coverage not exercised'},
                sast: {contracted: false, reason: 'fixture: no security command'},
            }),
            holdout,
            dataDir,
            workDir,
            owner: 'acme',
            repo: 'widgets',
            shipMode: 'live',
            designSystemDocs: () => Promise.resolve([]),
            ...overrides,
        }
    }

    // -- preflight ------------------------------------------------------------

    it('preflight creates the per-task worktree forked off staging and advances to tests', async () => {
        const handlers = makePhaseHandlers(makeDeps())
        const ctx = await ctxFor({task_id: 't-multi'})
        const result = await handlers.preflight(ctx)

        expect(result).toEqual({kind: 'advance', to: 'tests'})
        const wtPath = taskWorktreePath(workDir, RUN_ID, 't-multi')
        expect(git.worktrees.get(wtPath)).toBe('factory/run-1/t-multi')
    })

    it('preflight forks the worktree from the per-run staging branch (staging/<run-id>)', async () => {
        // Seed the per-run staging branch so revParse("origin/staging-run-1") succeeds.
        const perRunGit = new FakeGitClient({remoteHeads: {'staging-run-1': 'sha-run-staging'}})
        const handlers = makePhaseHandlers(makeDeps({git: perRunGit}))
        const ctx = await ctxFor({task_id: 't-multi'})
        await handlers.preflight(ctx)

        const wtPath = taskWorktreePath(workDir, RUN_ID, 't-multi')
        // The worktree add startPoint must be origin/staging/<run-id>, not origin/staging.
        expect(perRunGit.calls).toContain(`worktree add -b factory/run-1/t-multi ${wtPath} origin/staging-run-1`)
    })

    it('preflight provisions the worktree with the configured setupCommand before advancing', async () => {
        const calls: {path: string; setupCommand?: string | undefined}[] = []
        const cfg = defaultConfig()
        const deps = makeDeps({
            config: {...cfg, quality: {...cfg.quality, setupCommand: 'npm ci'}},
            provision: (args) => {
                calls.push({path: args.path, setupCommand: args.setupCommand})
                return Promise.resolve()
            },
        })
        const handlers = makePhaseHandlers(deps)
        const ctx = await ctxFor({task_id: 't-prov'})

        const result = await handlers.preflight(ctx)

        expect(result).toEqual({kind: 'advance', to: 'tests'})
        expect(calls).toEqual([{path: taskWorktreePath(workDir, RUN_ID, 't-prov'), setupCommand: 'npm ci'}])
    })

    it('preflight is REPLAY-SAFE: a resume after a provisioning failure re-creates and reaches provision again, not a worktree-add fatal', async () => {
        let provisionCalls = 0
        const deps = makeDeps({
            provision: () => {
                provisionCalls += 1
                if (provisionCalls === 1) {
                    throw new Error('npm ci failed (simulated network blip)')
                }
                return Promise.resolve()
            },
        })
        const handlers = makePhaseHandlers(deps)
        const ctx = await ctxFor({task_id: 't-multi'})

        // First preflight: the worktree is created, provisioning throws → the task cursor
        // stays at preflight (the phase never advanced) with the worktree on disk.
        await expect(handlers.preflight(ctx)).rejects.toThrow(/npm ci failed/)
        const wtPath = taskWorktreePath(workDir, RUN_ID, 't-multi')
        expect(git.worktrees.has(wtPath)).toBe(true)

        // Resume: preflight re-runs. createTaskWorktree must REUSE the existing worktree
        // (not fatal on `worktree add`), so provisioning — now succeeding — advances.
        const result = await handlers.preflight(ctx)
        expect(result).toEqual({kind: 'advance', to: 'tests'})
        expect(provisionCalls).toBe(2)
    })

    // N2 (S2 parallel enablers): concurrent preflights on the SAME staging branch must
    // serialize their git critical section (fetch → worktree add → assertBaseIsStagingTip).
    // The shared main-repo .git contends on index.lock, and the shared origin/staging-<run>
    // tracking ref can move between one task's fetch and another's assert, spuriously
    // tripping D12 invariant #4. The preflight file lock makes the section atomic.
    it('N2: concurrent preflights never interleave the fetch→add→assert git section', async () => {
        // Instrument the fake so every git op yields to the event loop — without the
        // lock, two concurrent preflights deterministically interleave (maxActive 2).
        // Critical section = fetch entry → mergeBase exit (assertBaseIsStagingTip's
        // last call in createTaskWorktree).
        let active = 0
        let maxActive = 0
        const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

        const origFetch = git.fetch.bind(git)
        git.fetch = async (...args: Parameters<FakeGitClient['fetch']>) => {
            active += 1
            maxActive = Math.max(maxActive, active)
            await tick()
            return origFetch(...args)
        }
        const origWorktreeAdd = git.worktreeAdd.bind(git)
        git.worktreeAdd = async (...args: Parameters<FakeGitClient['worktreeAdd']>) => {
            await tick()
            return origWorktreeAdd(...args)
        }
        const origRevParse = git.revParse.bind(git)
        git.revParse = async (...args: Parameters<FakeGitClient['revParse']>) => {
            await tick()
            return origRevParse(...args)
        }
        const origMergeBase = git.mergeBase.bind(git)
        git.mergeBase = async (...args: Parameters<FakeGitClient['mergeBase']>) => {
            const result = await origMergeBase(...args)
            active -= 1
            await tick()
            return result
        }

        const handlers = makePhaseHandlers(
            makeDeps({
                provision: async () => {
                    /* no-op */
                },
            })
        )
        const ctx1 = await ctxFor({task_id: 't-par-1'})
        const ctx2 = await ctxFor({task_id: 't-par-2'})

        const [r1, r2] = await Promise.all([handlers.preflight(ctx1), handlers.preflight(ctx2)])

        expect(r1).toEqual({kind: 'advance', to: 'tests'})
        expect(r2).toEqual({kind: 'advance', to: 'tests'})
        expect(git.worktrees.get(taskWorktreePath(workDir, RUN_ID, 't-par-1'))).toBeDefined()
        expect(git.worktrees.get(taskWorktreePath(workDir, RUN_ID, 't-par-2'))).toBeDefined()
        // The load-bearing assertion: the git sections ran strictly one-at-a-time.
        expect(maxActive).toBe(1)
    })

    it("N2: provisionWorktree stays OUTSIDE the preflight lock (slow install does not block the sibling's git section)", async () => {
        // The FIRST task to provision blocks until the SECOND task's fetch is observed.
        // If the lock (wrongly) covered provision, the sibling's fetch could never start
        // while the first held the lock → deadlock (test timeout). Both preflights
        // completing proves provision runs outside the critical section.
        let fetches = 0
        let resolveSecondFetch!: () => void
        const secondFetchSeen = new Promise<void>((resolve) => {
            resolveSecondFetch = resolve
        })
        const origFetch = git.fetch.bind(git)
        git.fetch = async (...args: Parameters<FakeGitClient['fetch']>) => {
            fetches += 1
            if (fetches === 2) {
                resolveSecondFetch()
            }
            return origFetch(...args)
        }

        let provisions = 0
        const deps = makeDeps({
            provision: async () => {
                provisions += 1
                if (provisions === 1) {
                    await secondFetchSeen
                }
            },
        })
        const handlers = makePhaseHandlers(deps)
        const ctx1 = await ctxFor({task_id: 't-slow-1'})
        const ctx2 = await ctxFor({task_id: 't-slow-2'})

        const [r1, r2] = await Promise.all([handlers.preflight(ctx1), handlers.preflight(ctx2)])

        expect(r1).toEqual({kind: 'advance', to: 'tests'})
        expect(r2).toEqual({kind: 'advance', to: 'tests'})
        expect(provisions).toBe(2)
    })

    // -- tests ----------------------------------------------------------------

    it('tests persists the holdout answer-key and spawns the test-writer (rung 0)', async () => {
        const deps = makeDeps()
        const handlers = makePhaseHandlers(deps)
        const ctx = await ctxFor({task_id: 't-multi', escalation_rung: 0})
        const result = await handlers.tests(ctx)

        // 5 criteria @ 20% ⇒ exactly 1 withheld ⇒ answer-key persisted.
        expect(await holdout.has(RUN_ID, 't-multi')).toBe(true)
        const record = await holdout.get(RUN_ID, 't-multi')
        expect(record.withheld_count).toBe(1)
        expect(record.total_criteria).toBe(5)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        expect(result.request.resume_phase).toBe('exec')
        expect(result.request.agents).toHaveLength(1)
        const agent = at(result.request.agents, 0)
        expect(agent.role).toBe('test-writer')

        // The persisted context is built off the holdout-stripped visible criteria,
        // and the rung-0 dial injects NO prior-failure note. test-writer is pinned to
        // the ceiling model regardless of rung/tier (only the implementer follows the
        // tiered dial) — see selectProducerModel('high', ...) in producerSpawn.
        expect(agent.model).toBe(selectProducerModel('high', deps.config))
        expect(agent.effort).toBeUndefined() // rung 0 carries no effort override
        // The inlined prompt (3b(i)) is built off the holdout-stripped visible criteria.
        expect(criteriaFromPrompt(nonNull(agent.prompt))).toHaveLength(4) // 5 total − 1 withheld
        expect(agent.prompt).not.toContain("Prior failures — don't repeat these:")
    })

    it('tests on a single-criterion task withholds nothing (no answer-key) but still spawns', async () => {
        const handlers = makePhaseHandlers(makeDeps())
        const ctx = await ctxFor({task_id: 't-single'})
        const result = await handlers.tests(ctx)

        expect(await holdout.has(RUN_ID, 't-single')).toBe(false)
        expect(result.kind).toBe('spawn-agents')
    })

    it('tests skips the test-writer for a tdd_exempt task (advance straight to exec)', async () => {
        const handlers = makePhaseHandlers(makeDeps())
        const ctx = await ctxFor({task_id: 't-exempt'})
        const result = await handlers.tests(ctx)

        // The answer-key is STILL persisted (holdout is independent of TDD exemption).
        expect(await holdout.has(RUN_ID, 't-exempt')).toBe(true)
        expect(result).toEqual({kind: 'advance', to: 'exec'})
    })

    it('tests re-expresses the escalated dial off the persisted rung (rung 2 injects prior-failure)', async () => {
        const deps = makeDeps()
        const handlers = makePhaseHandlers(deps)
        const ctx = await ctxFor({task_id: 't-multi', escalation_rung: 2})
        const result = await handlers.tests(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        const agent = at(result.request.agents, 0)
        const dial = dialForRung('medium', 2, deps.config)
        expect(agent.model).toBe(dial.model)
        // Rung 2 for a sub-ceiling tier JUMPS to the ceiling model but has NOT begun the
        // effort climb, so the dialed effort is still undefined — and the request omits it.
        expect(agent.effort).toBe(dial.effort)
        expect(agent.effort).toBeUndefined()
        expect(dial.injectsPriorFailure).toBe(true)
        expect(agent.prompt).toContain("Prior failures — don't repeat these:")
    })

    it('tests injects the test-revision note even at rung 1 (gated on the persisted field, not the dial)', async () => {
        const deps = makeDeps()
        const handlers = makePhaseHandlers(deps)
        // Rung 1 dial does NOT inject a prior-failure note — but a defective-test
        // revision must still reach the regenerating test-writer.
        const ctx = await ctxFor({
            task_id: 't-multi',
            escalation_rung: 1,
            test_revision_feedback: 'pins user_id = auth.uid() — must assert behavior, not source',
        })
        const result = await handlers.tests(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        const agent = at(result.request.agents, 0)
        expect(dialForRung('medium', 1, deps.config).injectsPriorFailure).toBe(false)
        expect(agent.prompt).toContain("Prior failures — don't repeat these:")
        expect(agent.prompt).toContain('auth.uid()')
    })

    it('tests injects the e2e-reopen note (Decision 39) even at rung 1, alongside a test-revision note', async () => {
        const deps = makeDeps()
        const handlers = makePhaseHandlers(deps)
        const ctx = await ctxFor({
            task_id: 't-multi',
            escalation_rung: 1,
            e2e_feedback: 'checkout: expected order confirmation, got 500',
        })
        const result = await handlers.tests(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        const agent = at(result.request.agents, 0)
        expect(agent.prompt).toContain("Prior failures — don't repeat these:")
        expect(agent.prompt).toContain('order confirmation')
    })

    it('tests threads the dialed effort into the request once the model has hit its ceiling (rung 3 = ceiling+xhigh)', async () => {
        const deps = makeDeps()
        const handlers = makePhaseHandlers(deps)
        const ctx = await ctxFor({task_id: 't-multi', escalation_rung: 3})
        const result = await handlers.tests(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        const agent = at(result.request.agents, 0)
        const dial = dialForRung('medium', 3, deps.config)
        // The effort climb is now live: the request must carry the dialed effort verbatim.
        expect(dial.effort).toBe('xhigh')
        expect(agent.effort).toBe('xhigh')
        expect(agent.effort).toBe(dial.effort)
        expect(agent.model).toBe(dial.model)
    })

    // -- exec -----------------------------------------------------------------

    it('exec spawns the implementer and resumes at verify', async () => {
        const handlers = makePhaseHandlers(makeDeps())
        const ctx = await ctxFor({task_id: 't-multi'})
        const result = await handlers.exec(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        expect(result.request.resume_phase).toBe('verify')
        expect(at(result.request.agents, 0).role).toBe('implementer')
    })

    it('exec cites design-system docs for a frontend task', async () => {
        const designSystemDocs = vi.fn(() => Promise.resolve(['docs/design-system.md']))
        const handlers = makePhaseHandlers(makeDeps({designSystemDocs}))
        const result = await handlers.exec(await ctxFor({task_id: 't-multi'}))

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        expect(designSystemDocs).toHaveBeenCalledOnce()
        expect(at(result.request.agents, 0).prompt).toContain('docs/design-system.md')
    })

    it('omits design-system guidance for test writers and backend implementer tasks', async () => {
        const designSystemDocs = vi.fn(() => Promise.resolve(['docs/design-system.md']))
        const handlers = makePhaseHandlers(makeDeps({designSystemDocs}))

        const testWriter = await handlers.tests(await ctxFor({task_id: 't-multi'}))
        const backendImplementer = await handlers.exec(await ctxFor({task_id: 't-single'}))

        expect(testWriter.kind).toBe('spawn-agents')
        expect(backendImplementer.kind).toBe('spawn-agents')
        if (testWriter.kind !== 'spawn-agents' || backendImplementer.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        expect(designSystemDocs).not.toHaveBeenCalled()
        expect(at(testWriter.request.agents, 0).prompt).not.toContain('Design system:')
        expect(at(backendImplementer.request.agents, 0).prompt).not.toContain('Design system:')
    })

    it("exec injects the e2e-reopen note (Decision 39) into the implementer's context", async () => {
        const deps = makeDeps()
        const handlers = makePhaseHandlers(deps)
        const ctx = await ctxFor({
            task_id: 't-multi',
            e2e_feedback: 'checkout: expected order confirmation, got 500',
        })
        const result = await handlers.exec(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        const agent = at(result.request.agents, 0)
        expect(agent.prompt).toContain("Prior failures — don't repeat these:")
        expect(agent.prompt).toContain('order confirmation')
    })

    it("exec threads a persisted fix_findings record (D5 fix-forward) into the implementer's fixInstructions", async () => {
        const deps = makeDeps()
        const handlers = makePhaseHandlers(deps)
        const ctx = await ctxFor({
            task_id: 't-multi',
            fix_findings: [
                {
                    reviewer: 'lint',
                    file: 'src/lib/x.ts',
                    line: 10,
                    description: 'eslint exit=1: no-unsafe-assignment',
                },
            ],
        })
        const result = await handlers.exec(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        const agent = at(result.request.agents, 0)
        expect(agent.prompt).toContain('Confirmed blockers to fix')
        expect(agent.prompt).toContain('- [lint] (src/lib/x.ts:10) eslint exit=1: no-unsafe-assignment')
    })

    it('exec with no fix_findings yields empty fixInstructions (a fresh attempt, not a patch)', async () => {
        const handlers = makePhaseHandlers(makeDeps())
        const ctx = await ctxFor({task_id: 't-multi'})
        const result = await handlers.exec(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        const agent = at(result.request.agents, 0)
        expect(agent.prompt).not.toContain('Confirmed blockers to fix')
    })

    // -- verify (CLI single-step reporter; NO holdout) ------------------------

    it('verify with no reviewers yet spawns the full risk-invariant panel', async () => {
        const handlers = makePhaseHandlers(makeDeps())
        const ctx = await ctxFor({task_id: 't-multi', reviewers: []})
        const result = await handlers.verify(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        expect(result.request.agents).toHaveLength(PANEL_ROLES.length)
        // 3b(iii): the real verify-phase handler stamps verifier_spec on every panel manifest.
        expect(result.request.verifier_spec).toMatchObject({agent_type: 'finding-verifier', isolation: 'worktree'})
    })

    it('verify RE-SPAWNS the panel when only a SUBSET of reviewers is on record (fail-closed roster)', async () => {
        // A persisted <PANEL_ROLES.length roster (here 2 approving) must NOT derive a passing
        // merge gate on the fast-path — an all-approve subset would otherwise ship on a partial
        // panel. The cardinality guard re-routes to a fresh full-panel spawn instead.
        const handlers = makePhaseHandlers(makeDeps())
        const subset: ReviewerResult[] = [
            {reviewer: 'implementation-reviewer', verdict: 'approve', confirmed_blockers: 0},
            {reviewer: 'quality-reviewer', verdict: 'approve', confirmed_blockers: 0},
        ]
        const ctx = await ctxFor({task_id: 't-multi', reviewers: subset})
        const result = await handlers.verify(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        expect(result.request.agents).toHaveLength(PANEL_ROLES.length)
    })

    it('verify RE-SPAWNS the panel when a holdout task has NO verdicts on record (fail-closed guard)', async () => {
        // A withheld answer key with a full approving roster but no persisted verdicts
        // implies an unsanctioned reviewers write — the fast-path must not derive.
        await holdout.put(RUN_ID, makeHoldoutRecord('t-multi', ['d', 'e'], 5))
        const handlers = makePhaseHandlers(makeDeps())
        const ctx = await ctxFor({task_id: 't-multi', reviewers: approvingPanel()})
        const result = await handlers.verify(ctx)

        expect(result.kind).toBe('spawn-agents')
    })

    it('S1: a stale PRIOR-RUNG holdout verdict does not satisfy the fast-path after an escalation bump', async () => {
        // Verdicts persisted at rung 0 must be invisible once the task escalated to rung 1 —
        // the store is rung-keyed, so the fast-path fails closed and re-spawns the panel.
        await holdout.put(RUN_ID, makeHoldoutRecord('t-multi', ['d', 'e'], 5))
        await new FsHoldoutVerdictStore(dataDir).put(RUN_ID, 't-multi', 0, [
            {criterion: 'd', satisfied: true, evidence: 'src/x.ts:10'},
            {criterion: 'e', satisfied: true, evidence: 'src/y.ts:3'},
        ])
        const handlers = makePhaseHandlers(makeDeps())
        const ctx = await ctxFor({task_id: 't-multi', reviewers: approvingPanel(), escalation_rung: 1})
        const result = await handlers.verify(ctx)

        expect(result.kind).toBe('spawn-agents')
    })

    it('S1: current-rung holdout verdicts DO satisfy the fast-path — advance to ship', async () => {
        await holdout.put(RUN_ID, makeHoldoutRecord('t-multi', ['d', 'e'], 5))
        await new FsHoldoutVerdictStore(dataDir).put(RUN_ID, 't-multi', 1, [
            {criterion: 'd', satisfied: true, evidence: 'src/x.ts:10'},
            {criterion: 'e', satisfied: true, evidence: 'src/y.ts:3'},
        ])
        const handlers = makePhaseHandlers(makeDeps())
        const ctx = await ctxFor({task_id: 't-multi', reviewers: approvingPanel(), escalation_rung: 1})
        const result = await handlers.verify(ctx)

        expect(result).toEqual({kind: 'advance', to: 'ship'})
    })

    // Decision 51 — a probe whose diff touches a migration file (otherwise identical
    // to greenProbe) triggers the content-conditional database-design-reviewer.
    function dbProbe(): FakeGitProbe {
        return new FakeGitProbe({
            refs: {'origin/staging-run-1': 'sha-base', HEAD: 'sha-head'},
            changedFiles: ['db/migrate/20260706_create_orders.rb'],
            commits: [
                commit({sha: 'c1', files: ['src/x.test.ts'], tagged: true}),
                commit({sha: 'c2', files: ['src/x.ts'], tagged: true}),
            ],
        })
    }

    it('D51: verify spawns floor + database-design-reviewer when the diff touches DB files', async () => {
        const handlers = makePhaseHandlers(makeDeps({tools: makeFakeTools({git: dbProbe()})}))
        const ctx = await ctxFor({task_id: 't-multi', reviewers: []})
        const result = await handlers.verify(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        expect(result.request.agents).toHaveLength(PANEL_ROLES.length + 1)
        expect(result.request.agents.map((a) => a.role)).toContain('database-design-reviewer')
    })

    it('D51: on a DB-touching diff a persisted floor-only roster is a SUBSET — verify re-spawns', async () => {
        const handlers = makePhaseHandlers(makeDeps({tools: makeFakeTools({git: dbProbe()})}))
        const ctx = await ctxFor({task_id: 't-multi', reviewers: approvingPanel()}) // 4 approvals, no specialist
        const result = await handlers.verify(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        expect(result.request.agents).toHaveLength(PANEL_ROLES.length + 1)
    })

    it('S5/C: default config stamps a deterministic absent cross_vendor WITHOUT probing (hermetic)', async () => {
        const handlers = makePhaseHandlers(makeDeps())
        const ctx = await ctxFor({task_id: 't-multi', reviewers: []})
        const result = await handlers.verify(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        expect(result.request.cross_vendor).toEqual({
            status: 'absent',
            reason: 'no cross-vendor model configured (codex.model)',
        })
    })

    it('S5/C: with codex.model configured + probe available, the manifest stamps cross_vendor present', async () => {
        const cfg = defaultConfig()
        const deps = makeDeps({
            config: {...cfg, codex: {...cfg.codex, model: 'gpt-5-codex'}},
            vendorProbe: {vendor: 'codex', available: () => Promise.resolve(true)},
        })
        const handlers = makePhaseHandlers(deps)
        const ctx = await ctxFor({task_id: 't-multi', reviewers: []})
        const result = await handlers.verify(ctx)

        expect(result.kind).toBe('spawn-agents')
        if (result.kind !== 'spawn-agents') {
            throw new Error('unreachable')
        }
        expect(result.request.cross_vendor?.status).toBe('present')
        expect(result.request.cross_vendor).toMatchObject({status: 'present', model: 'gpt-5-codex'})
        // 3b(ii): the engine composes the codex prompt at spawn time — non-empty, carries the review charter.
        expect(
            result.request.cross_vendor?.status === 'present' ? result.request.cross_vendor.prompt : undefined
        ).toContain('RawReview')
    })

    it('S5/C: requireCrossVendor=block + absent fails TERMINAL blocked-environmental WITHOUT spawning the panel', async () => {
        const cfg = defaultConfig()
        const deps = makeDeps({
            config: {
                ...cfg,
                codex: {...cfg.codex, model: 'gpt-5-codex'},
                review: {...cfg.review, requireCrossVendor: 'block'},
            },
            // Probe says codex is NOT runnable — quota must not burn a 4-reviewer panel,
            // and the ladder must not burn implementer re-runs against a missing binary.
            vendorProbe: {vendor: 'codex', available: () => Promise.resolve(false)},
        })
        const handlers = makePhaseHandlers(deps)
        const ctx = await ctxFor({task_id: 't-multi', reviewers: []})
        const result = await handlers.verify(ctx)

        expect(result.kind).toBe('task-terminal')
        if (result.kind !== 'task-terminal' || result.outcome.outcome !== 'failed') {
            throw new Error('unreachable')
        }
        expect(result.outcome.failure_class).toBe('blocked-environmental')
        expect(result.outcome.reason).toContain('requireCrossVendor=block')
        expect(result.outcome.reason).toContain('codex')
    })

    it('verify advances to ship when gates are green and reviewers unanimously approve', async () => {
        const handlers = makePhaseHandlers(makeDeps())
        const ctx = await ctxFor({task_id: 't-multi', reviewers: approvingPanel()})
        const result = await handlers.verify(ctx)

        expect(result).toEqual({kind: 'advance', to: 'ship'})
    })

    it('verify blocks (wait-retry) when a deterministic gate fails despite reviewer approval', async () => {
        const deps = makeDeps({
            tools: makeFakeTools({git: greenProbe(), eslint: new FakeEslint(proc(1))}),
        })
        const handlers = makePhaseHandlers(deps)
        const ctx = await ctxFor({task_id: 't-multi', reviewers: approvingPanel()})
        const result = await handlers.verify(ctx)

        expect(result.kind).toBe('wait-retry')
        if (result.kind !== 'wait-retry') {
            throw new Error('unreachable')
        }
        expect(result.phase).toBe('verify')
        expect(result.reason).toMatch(/lint/)
    })

    it('verify (resume path) names the failing gate WITH its detail, via the shared mergeGateBlockReason', async () => {
        // The handlers verify reporter used to hold a TWIN mergeGateBlockReason that named
        // gates by id ALONE ("gates failed: lint") — dropping the `detail`. After
        // unifying on the shared helper, the resume / merge-resync path must surface
        // the same gate detail (e.g. "eslint exit=1") the fresh-review path does.
        const deps = makeDeps({
            tools: makeFakeTools({git: greenProbe(), eslint: new FakeEslint(proc(1))}),
        })
        const handlers = makePhaseHandlers(deps)
        const ctx = await ctxFor({task_id: 't-multi', reviewers: approvingPanel()})
        const result = await handlers.verify(ctx)

        expect(result.kind).toBe('wait-retry')
        if (result.kind !== 'wait-retry') {
            throw new Error('unreachable')
        }
        expect(result.reason).toMatch(/failed gates: lint \(eslint exit=/)
    })

    it('verify gate uses staging/<run-id> as baseRef (per-run branch, not shared staging)', async () => {
        // Probe that ONLY resolves origin/staging/<run-id>. If the handler still passes
        // origin/staging, resolveBase returns null → TDD gate fails with base_ref_not_found
        // → wait-retry (gate failure). With the correct per-run baseRef the TDD gate resolves
        // the remote and the green commit history passes → advance to ship.
        const perRunProbe = new FakeGitProbe({
            refs: {'origin/staging-run-1': 'sha-run-staging', HEAD: 'sha-head'},
            changedFiles: [],
            commits: [
                commit({sha: 'c1', files: ['src/x.test.ts'], tagged: true}),
                commit({sha: 'c2', files: ['src/x.ts'], tagged: true}),
            ],
        })
        const deps = makeDeps({tools: makeFakeTools({git: perRunProbe})})
        const handlers = makePhaseHandlers(deps)
        const ctx = await ctxFor({task_id: 't-multi', reviewers: approvingPanel()})
        const result = await handlers.verify(ctx)

        // Must advance to ship — the gate must have resolved origin/staging-run-1 as its
        // diff base, not origin/staging.
        expect(result).toEqual({kind: 'advance', to: 'ship'})
    })

    // -- ship (stubbed: routed to shipTask on the live path) ------------------

    it('ship is a loud throw-stub — runPhase must never dispatch it (routed to shipTask)', async () => {
        const handlers = makePhaseHandlers(makeDeps())
        const ctx = await ctxFor({task_id: 't-multi'})

        // The orchestrator runs the stateful shipTask (src/orchestrator/ship.ts) directly; this
        // reporter exists ONLY to keep PhaseHandlers total. Invoking it is a programming
        // error → synchronous loud throw, with no PR opened as a side effect.
        expect(() => handlers.ship(ctx)).toThrow(/ship is routed to shipTask/)
        expect(gh.created).toHaveLength(0)
    })

    // -- finalize -------------------------------------------------------------

    it('finalize over an all-done run yields a finalize-terminal completed result', async () => {
        const handlers = makePhaseHandlers(makeDeps())
        await state.update(RUN_ID, (s) => ({
            ...s,
            tasks: {
                d1: {
                    task_id: 'd1',
                    status: 'done',
                    depends_on: [],
                    risk_tier: 'low',
                    escalation_rung: 0,
                    reviewers: [],
                    merge_resyncs: 0,
                },
            },
        }))
        const run = await state.read(RUN_ID)
        const result = await handlers.finalize({run})
        expect(result).toEqual({kind: 'finalize-terminal', run_status: 'completed'})
    })
})

// ---------------------------------------------------------------------------
// module-scope reporter helpers
// ---------------------------------------------------------------------------

describe('specTaskOf / shipBody', () => {
    it('specTaskOf resolves a present task and throws LOUD on run/spec drift', () => {
        const spec = makeSpec()
        expect(specTaskOf(spec, 't-multi').title).toBe('multi-criteria task')
        expect(() => specTaskOf(spec, 'ghost')).toThrow(/drift/i)
    })

    it('shipBody embeds the task id, title, run id, and risk tier', () => {
        const spec = makeSpec()
        const body = shipBody(RUN_ID, specTaskOf(spec, 't-multi'))
        expect(body).toContain('t-multi')
        expect(body).toContain('multi-criteria task')
        expect(body).toContain(RUN_ID)
        expect(body).toContain('medium')
    })
})
