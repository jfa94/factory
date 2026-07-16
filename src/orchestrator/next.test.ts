/**
 * Unit tests for nextTask — the run-level orchestrator.
 *
 * Each test uses makeOrchestratorDeps from orchestrator-fixtures.ts. MakeOrchestratorDepsOpts supports:
 *   - tasks: multi-task DAGs with depends_on
 *   - taskStateOverrides: per-task status overrides
 *   - usage: quota reading
 *   - runStatusOverride: seed the run with a non-"running" status after creation
 *
 * State writes that bypass seeding (e.g., for pathological DAGs) use
 * deps.state.update / deps.state.updateTask directly in the test body.
 */
import {describe, expect, it} from 'vitest'

import {nextTask} from './next.js'
import {scanRun} from '../rescue/scan.js'
import {MAX_DOCS_ATTEMPTS} from './docs.js'
import {makeOrchestratorDeps, PAUSE_5H, NOW} from './orchestrator-fixtures.js'
import type {UsageReading} from '../quota/usage-source.js'
import {nonNull} from '../shared/index.js'

const UNAVAILABLE: UsageReading = {kind: 'unavailable', reason: 'usage-cache-missing'}

// S9: the traceability stage fires on EVERY prospectively-completed non-debug run.
// Tests pinning the docs/finalize legs seed it done so their pin stays on-target.
const TRACED = {
    status: 'done' as const,
    verdicts: [],
    ended_at: '2026-01-01T00:00:00.000Z',
}

describe('nextTask', () => {
    it('terminal run → run-terminal', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            runStatusOverride: 'completed',
        })
        try {
            const env = await nextTask(deps, runId)
            expect(env).toMatchObject({kind: 'done', run_status: 'completed'})
        } finally {
            await cleanup()
        }
    })

    it('quota breach → quota-blocked with persisted checkpoint', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({usage: PAUSE_5H})
        try {
            const env = await nextTask(deps, runId)
            expect(env).toMatchObject({kind: 'pause', scope: '5h'})
            const run = await deps.state.read(runId)
            expect(run.status).toBe('paused')
        } finally {
            await cleanup()
        }
    })

    it('fail-closes on an unobservable usage signal (suspend + quota marker written)', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({usage: UNAVAILABLE})
        try {
            const env = await nextTask(deps, runId)
            expect(env).toMatchObject({kind: 'pause', scope: 'unavailable'})
            const run = await deps.state.read(runId)
            expect(run.status).toBe('suspended')
            // A2 invariant: every quota-caused stop writes run.quota.
            expect(run.quota).toEqual({binding_window: 'unavailable'})
        } finally {
            await cleanup()
        }
    })

    it('recovered paused run is returned to running before reporting ready tasks', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1', acceptance_criteria: ['only one']}],
        })
        try {
            // Seed a realistic paused state with a real quota checkpoint so the
            // quota-cleared assertion discriminates (rather than being vacuously true).
            await deps.state.update(runId, (s) => ({
                ...s,
                status: 'paused' as const,
                quota: {binding_window: '5h' as const, resets_at_epoch: 1_700_018_000},
            }))
            const env = await nextTask(deps, runId)
            expect(env.kind).toBe('work')
            const run = await deps.state.read(runId)
            expect(run.status).toBe('running')
            // quota checkpoint must be cleared (the clearCheckpoint block)
            expect(run.quota).toBeUndefined()
        } finally {
            await cleanup()
        }
    })

    it('cascade-fails pending tasks whose dependency failed, transitively', async () => {
        // T1 failed; T2 depends_on [T1]; T3 depends_on [T2]; T4 independent pending
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            tasks: [
                {task_id: 'T1', acceptance_criteria: ['only one']},
                {task_id: 'T2', acceptance_criteria: ['only one'], depends_on: ['T1']},
                {task_id: 'T3', acceptance_criteria: ['only one'], depends_on: ['T2']},
                {task_id: 'T4', acceptance_criteria: ['only one']},
            ],
        })
        try {
            // Seed T1 as failed
            await deps.state.updateTask(runId, 'T1', (t) => ({
                ...t,
                status: 'failed',
                failure_class: 'capability-budget',
                failure_reason: 'test seed',
            }))

            const env = await nextTask(deps, runId)
            expect(env.kind).toBe('work')
            if (env.kind !== 'work') {
                return
            }
            expect(env.cascade_failed.slice().sort()).toEqual(['T2', 'T3'])
            expect(env.ready).toEqual(['T4'])
            const run = await deps.state.read(runId)
            // Decision 72: a cascade victim never ran — its class names the CAUSE
            // (a failed dependency), not the environment, and rescue sees it recoverable.
            expect(run.tasks.T2?.failure_class).toBe('blocked-dependency')
            expect(scanRun(run).tasks.find((t) => t.task_id === 'T2')?.disposition).toBe('recoverable')
        } finally {
            await cleanup()
        }
    })

    it('ready excludes tasks with un-done deps and orders in-flight (crash-resume) first', async () => {
        // T1 done; T2 pending depends_on [T1]; T3 status reviewing (in-flight, phase verify); T4 pending depends_on [T2]
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            tasks: [
                {task_id: 'T1', acceptance_criteria: ['only one']},
                {task_id: 'T2', acceptance_criteria: ['only one'], depends_on: ['T1']},
                {task_id: 'T3', acceptance_criteria: ['only one']},
                {task_id: 'T4', acceptance_criteria: ['only one'], depends_on: ['T2']},
            ],
        })
        try {
            // Seed T1 as done, T3 as reviewing (in-flight)
            await deps.state.updateTask(runId, 'T1', (t) => ({...t, status: 'done'}))
            await deps.state.updateTask(runId, 'T3', (t) => ({
                ...t,
                status: 'reviewing',
                phase: 'verify',
            }))

            const env = await nextTask(deps, runId)
            expect(env).toMatchObject({kind: 'work', ready: ['T3', 'T2']})
            if (env.kind !== 'work') {
                return
            }
            // T4 not ready (T2 not done), T1 terminal
            expect(env.ready).not.toContain('T1')
            expect(env.ready).not.toContain('T4')
        } finally {
            await cleanup()
        }
    })

    // N4 (S2): the work envelope carries the parallelism cap so the runner reads it
    // from the envelope, never the config file.
    it('work envelope carries max_parallel from config.maxParallelTasks', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1', acceptance_criteria: ['only one']}],
        })
        try {
            const env = await nextTask(deps, runId)
            expect(env).toMatchObject({kind: 'work', max_parallel: 3}) // schema default

            const bumped = {...deps, config: {...deps.config, maxParallelTasks: 5}}
            const env5 = await nextTask(bumped, runId)
            expect(env5).toMatchObject({kind: 'work', max_parallel: 5})
        } finally {
            await cleanup()
        }
    })

    // S1: engine-side stall TTL — an in-flight spawn whose clock has aged past
    // config.stallTtlMinutes is flagged in work.stale (advisory, status unchanged).
    describe('work.stale (S1 stall TTL)', () => {
        /** Seed T1 in-flight (status executing, phase exec) with a given spawned_at. */
        async function seedInFlight(
            deps: Awaited<ReturnType<typeof makeOrchestratorDeps>>['deps'],
            runId: string,
            spawnedAt: number
        ) {
            await deps.state.updateTask(runId, 'T1', (t) => ({
                ...t,
                status: 'executing',
                phase: 'exec',
                spawn_in_flight: {phase: 'exec', rung: 0, tip_sha: 'sha', spawned_at: spawnedAt, redrives: 0},
            }))
        }

        it('a spawn older than the TTL lands in work.stale', async () => {
            const {deps, runId, cleanup} = await makeOrchestratorDeps({
                tasks: [{task_id: 'T1', acceptance_criteria: ['only one']}],
            })
            try {
                await seedInFlight(deps, runId, NOW - 2000) // default stallTtlMinutes=15 → 900s
                const env = await nextTask(deps, runId)
                expect(env).toMatchObject({kind: 'work', stale: ['T1'], hung: []})
            } finally {
                await cleanup()
            }
        })

        it('a fresh spawn does not land in work.stale', async () => {
            const {deps, runId, cleanup} = await makeOrchestratorDeps({
                tasks: [{task_id: 'T1', acceptance_criteria: ['only one']}],
            })
            try {
                await seedInFlight(deps, runId, NOW - 10)
                const env = await nextTask(deps, runId)
                expect(env).toMatchObject({kind: 'work', stale: [], hung: []})
            } finally {
                await cleanup()
            }
        })

        it('a re-drive (spawned_at refreshed) clears staleness', async () => {
            const {deps, runId, cleanup} = await makeOrchestratorDeps({
                tasks: [{task_id: 'T1', acceptance_criteria: ['only one']}],
            })
            try {
                await seedInFlight(deps, runId, NOW - 2000)
                const staleEnv = await nextTask(deps, runId)
                expect(staleEnv).toMatchObject({kind: 'work', stale: ['T1']})

                // Simulate the orchestrator's re-drive refresh (orchestrator.test.ts pins the
                // write side; this pins next.ts reacting to the refreshed clock).
                await deps.state.updateTask(runId, 'T1', (t) => ({
                    ...t,
                    spawn_in_flight:
                        t.spawn_in_flight === undefined ? undefined : {...t.spawn_in_flight, spawned_at: NOW},
                }))

                const freshEnv = await nextTask(deps, runId)
                expect(freshEnv).toMatchObject({kind: 'work', stale: []})
            } finally {
                await cleanup()
            }
        })

        it('respects a configured stallTtlMinutes override', async () => {
            const {deps, runId, cleanup} = await makeOrchestratorDeps({
                tasks: [{task_id: 'T1', acceptance_criteria: ['only one']}],
            })
            try {
                await seedInFlight(deps, runId, NOW - 120)
                // 120s old task: not stale at the 15min default, IS stale at a 1min TTL.
                const defaultEnv = await nextTask(deps, runId)
                expect(defaultEnv).toMatchObject({kind: 'work', stale: []})

                const tightened = {...deps, config: {...deps.config, stallTtlMinutes: 1}}
                const tightEnv = await nextTask(tightened, runId)
                expect(tightEnv).toMatchObject({kind: 'work', stale: ['T1']})
            } finally {
                await cleanup()
            }
        })

        // Decision 66: the HARD band — past hungSpawnMinutes the task moves from
        // `stale` (liveness-checked) to `hung` (kill-even-if-alive). Disjoint sets.
        it('a spawn older than hungSpawnMinutes lands in work.hung, not work.stale', async () => {
            const {deps, runId, cleanup} = await makeOrchestratorDeps({
                tasks: [{task_id: 'T1', acceptance_criteria: ['only one']}],
            })
            try {
                await seedInFlight(deps, runId, NOW - 8000) // default hungSpawnMinutes=120 → 7200s
                const env = await nextTask(deps, runId)
                expect(env).toMatchObject({kind: 'work', stale: [], hung: ['T1']})
            } finally {
                await cleanup()
            }
        })

        it('respects a configured hungSpawnMinutes override', async () => {
            const {deps, runId, cleanup} = await makeOrchestratorDeps({
                tasks: [{task_id: 'T1', acceptance_criteria: ['only one']}],
            })
            try {
                await seedInFlight(deps, runId, NOW - 2000) // stale at defaults (900 < 2000 ≤ 7200)
                const defaultEnv = await nextTask(deps, runId)
                expect(defaultEnv).toMatchObject({kind: 'work', stale: ['T1'], hung: []})

                const tightened = {...deps, config: {...deps.config, hungSpawnMinutes: 30}} // 1800s
                const tightEnv = await nextTask(tightened, runId)
                expect(tightEnv).toMatchObject({kind: 'work', stale: [], hung: ['T1']})
            } finally {
                await cleanup()
            }
        })

        it('a legacy checkpoint without spawned_at (default 0) lands in work.hung', async () => {
            const {deps, runId, cleanup} = await makeOrchestratorDeps({
                tasks: [{task_id: 'T1', acceptance_criteria: ['only one']}],
            })
            try {
                await seedInFlight(deps, runId, 0) // maximally aged — never silently trusted
                const env = await nextTask(deps, runId)
                expect(env).toMatchObject({kind: 'work', stale: [], hung: ['T1']})
            } finally {
                await cleanup()
            }
        })
    })

    it('all tasks terminal → all-terminal', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            tasks: [
                {task_id: 'T1', acceptance_criteria: ['only one']},
                {task_id: 'T2', acceptance_criteria: ['only one']},
            ],
        })
        try {
            // Seed T1 done, T2 failed
            await deps.state.updateTask(runId, 'T1', (t) => ({...t, status: 'done'}))
            await deps.state.updateTask(runId, 'T2', (t) => ({
                ...t,
                status: 'failed',
                failure_class: 'capability-budget',
                failure_reason: 'test seed',
            }))

            const env = await nextTask(deps, runId)
            expect(env).toMatchObject({kind: 'finalize'})
        } finally {
            await cleanup()
        }
    })

    // Decision 34: a dependency cycle must NOT throw — the circuit breaker fails each
    // wedged task as spec-defect and returns all-terminal so the run finalizes to failed.
    it('dependency cycle (T1↔T2) → all-terminal with both tasks spec-defect failed', async () => {
        // Pathological DAG: T1 executing with depends_on [T2], T2 pending depends_on [T1]
        // This bypasses seeding via direct state writes.
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            tasks: [
                {task_id: 'T1', acceptance_criteria: ['only one']},
                {task_id: 'T2', acceptance_criteria: ['only one']},
            ],
        })
        try {
            // Construct the cycle directly, bypassing normal seeding
            await deps.state.update(runId, (s) => ({
                ...s,
                tasks: {
                    T1: {
                        ...nonNull(s.tasks.T1),
                        status: 'executing' as const,
                        phase: 'exec' as const,
                        depends_on: ['T2'],
                    },
                    T2: {
                        ...nonNull(s.tasks.T2),
                        status: 'pending' as const,
                        depends_on: ['T1'],
                    },
                },
            }))

            const env = await nextTask(deps, runId)
            expect(env.kind).toBe('finalize')
            if (env.kind !== 'finalize') {
                return
            }
            expect(env.cascade_failed.slice().sort()).toEqual(['T1', 'T2'])

            const run = await deps.state.read(runId)
            expect(run.tasks.T1?.status).toBe('failed')
            expect(run.tasks.T1?.failure_class).toBe('spec-defect')
            expect(run.tasks.T2?.status).toBe('failed')
            expect(run.tasks.T2?.failure_class).toBe('spec-defect')
        } finally {
            await cleanup()
        }
    })

    it('terminal run + quota-breach → run-terminal (no checkpoint written)', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            usage: PAUSE_5H,
            runStatusOverride: 'completed',
        })
        try {
            const env = await nextTask(deps, runId)
            expect(env).toMatchObject({kind: 'done', run_status: 'completed'})
            // Gate never ran — no checkpoint written
            const run = await deps.state.read(runId)
            expect(run.quota).toBeUndefined()
        } finally {
            await cleanup()
        }
    })

    // C1 pin: all tasks already terminal + 5h-breaching usage → all-terminal, no
    // checkpoint written (the pre-gate all-terminal check fires before applyQuotaGate).
    it('all-tasks-terminal + quota-breach → all-terminal with no checkpoint written', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1', acceptance_criteria: ['only one']}],
            usage: PAUSE_5H,
        })
        try {
            // Seed T1 as done so the run is effectively finished (traceability already
            // concluded — S9's pending phase would legitimately engage the quota gate).
            await deps.state.updateTask(runId, 'T1', (t) => ({...t, status: 'done'}))
            await deps.state.update(runId, (s) => ({...s, traceability: TRACED}))

            const env = await nextTask(deps, runId)
            expect(env).toMatchObject({kind: 'finalize', cascade_failed: []})
            // The quota gate must NOT have run — run stays running with no checkpoint
            const run = await deps.state.read(runId)
            expect(run.status).toBe('running')
            expect(run.quota).toBeUndefined()
        } finally {
            await cleanup()
        }
    })

    // I1 pin: cascade that resolves the run to all-terminal carries the failed ids.
    it('cascade resolving run to all-terminal → all-terminal with cascade_failed', async () => {
        // T1 failed; T2 pending depends_on [T1] — cascade fails T2, run is all-terminal.
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            tasks: [
                {task_id: 'T1', acceptance_criteria: ['only one']},
                {task_id: 'T2', acceptance_criteria: ['only one'], depends_on: ['T1']},
            ],
        })
        try {
            await deps.state.updateTask(runId, 'T1', (t) => ({
                ...t,
                status: 'failed',
                failure_class: 'capability-budget',
                failure_reason: 'test seed',
            }))

            const env = await nextTask(deps, runId)
            expect(env).toMatchObject({kind: 'finalize', cascade_failed: ['T2']})
        } finally {
            await cleanup()
        }
    })

    // Suspended recovery: a suspended run with a 7d checkpoint resumes cleanly.
    it('suspended run (7d checkpoint) is returned to running before reporting ready tasks', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1', acceptance_criteria: ['only one']}],
        })
        try {
            await deps.state.update(runId, (s) => ({
                ...s,
                status: 'suspended' as const,
                quota: {binding_window: '7d' as const, resets_at_epoch: 1_700_018_000},
            }))
            const env = await nextTask(deps, runId)
            expect(env.kind).toBe('work')
            const run = await deps.state.read(runId)
            expect(run.status).toBe('running')
            expect(run.quota).toBeUndefined()
        } finally {
            await cleanup()
        }
    })

    // Empty run (tasks: {}) is half-created wreckage (D57): creation seeds atomically,
    // so a zero-task run can only be a crash between birth and seeding on a pre-D57
    // engine. Throws LOUD naming the remedy — never a vacuous finalize.
    it('empty run (no tasks) → loud UsageError naming half-created + remedy', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps()
        try {
            // Clear the default T1 so the run has zero tasks.
            await deps.state.update(runId, (s) => ({...s, tasks: {}, traceability: TRACED}))

            await expect(nextTask(deps, runId)).rejects.toThrow(/zero tasks.*half-created.*run cancel/s)
        } finally {
            await cleanup()
        }
    })

    // Empty run + quota breach → the guard fires BEFORE the quota gate: wreckage
    // must never write a pause checkpoint (that would park it as "resumable").
    it('empty run + quota-breach → throws with no checkpoint written', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({usage: PAUSE_5H})
        try {
            await deps.state.update(runId, (s) => ({...s, tasks: {}, traceability: TRACED}))

            await expect(nextTask(deps, runId)).rejects.toThrow(/zero tasks/)
            const run = await deps.state.read(runId)
            expect(run.status).toBe('running')
            expect(run.quota).toBeUndefined()
        } finally {
            await cleanup()
        }
    })

    // Decision 34: self-dependency (T1→T1) is also a wedged/cycle state — the circuit
    // breaker fails T1 as spec-defect and returns all-terminal.
    it('self-dependency (T1 depends_on T1) → all-terminal with T1 spec-defect failed', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1', acceptance_criteria: ['only one']}],
        })
        try {
            // Inject the self-dep directly, bypassing normal seeding
            await deps.state.updateTask(runId, 'T1', (t) => ({
                ...t,
                depends_on: ['T1'],
            }))

            const env = await nextTask(deps, runId)
            expect(env.kind).toBe('finalize')
            if (env.kind !== 'finalize') {
                return
            }
            expect(env.cascade_failed).toContain('T1')

            const run = await deps.state.read(runId)
            expect(run.tasks.T1?.status).toBe('failed')
            expect(run.tasks.T1?.failure_class).toBe('spec-defect')
        } finally {
            await cleanup()
        }
    })

    // WS4 run-level circuit breaker: capability-budget fails at the cap abort the run —
    // every remaining runnable task is failed and the run finalizes (all-terminal → failed).
    it('circuit breaker: capability-budget fails at the cap abort runnable work → all-terminal', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            tasks: [
                {task_id: 'T1', acceptance_criteria: ['only one']},
                {task_id: 'T2', acceptance_criteria: ['only one']},
                {task_id: 'T3', acceptance_criteria: ['only one']},
                {task_id: 'T4', acceptance_criteria: ['only one']}, // independent, runnable
            ],
        })
        try {
            for (const id of ['T1', 'T2', 'T3']) {
                await deps.state.updateTask(runId, id, (t) => ({
                    ...t,
                    status: 'failed',
                    failure_class: 'capability-budget',
                    failure_reason: 'test seed',
                }))
            }

            const env = await nextTask(deps, runId)
            expect(env.kind).toBe('finalize')
            if (env.kind !== 'finalize') {
                return
            }
            expect(env.cascade_failed).toContain('T4')

            const run = await deps.state.read(runId)
            expect(run.tasks.T4?.status).toBe('failed')
            // Swept tasks are CONSEQUENCES of the trip, not independent failures: a
            // breaker-EXCLUDED class, or a rescue-reopen re-drive would re-trip on the
            // sweep's own output and undo any partial rescue.
            expect(run.tasks.T4?.failure_class).toBe('blocked-environmental')
            expect(run.tasks.T4?.failure_reason).toMatch(/circuit breaker tripped/)

            // Rescue sees the swept task as recoverable (it never ran) and the genuine
            // capability failures as dead-ends.
            const scan = scanRun(run)
            expect(scan.tasks.find((t) => t.task_id === 'T4')?.disposition).toBe('recoverable')
            expect(scan.tasks.find((t) => t.task_id === 'T1')?.disposition).toBe('dead-end')
        } finally {
            await cleanup()
        }
    })

    // Below the cap the breaker stays silent — an independent ready task is still
    // scheduled (the breaker must not abort runnable work prematurely).
    it('circuit breaker: below the cap does not abort — ready task still scheduled', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({
            tasks: [
                {task_id: 'T1', acceptance_criteria: ['only one']},
                {task_id: 'T2', acceptance_criteria: ['only one']},
                {task_id: 'T3', acceptance_criteria: ['only one']}, // independent, runnable
            ],
        })
        try {
            for (const id of ['T1', 'T2']) {
                await deps.state.updateTask(runId, id, (t) => ({
                    ...t,
                    status: 'failed',
                    failure_class: 'capability-budget',
                    failure_reason: 'test seed',
                }))
            }

            const env = await nextTask(deps, runId)
            expect(env).toMatchObject({kind: 'work', ready: ['T3']})
        } finally {
            await cleanup()
        }
    })
})

describe('docs-ready gate', () => {
    const DONE_AT = '2026-01-01T00:00:00.000Z'

    it('completed + docs applicable + docs not done → docs-ready', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
            docsApplicable: true,
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({...s, traceability: TRACED}))
            expect((await nextTask(deps, runId)).kind).toBe('document')
        } finally {
            await cleanup()
        }
    })

    it('completed + docs NOT applicable → all-terminal', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
            docsApplicable: false,
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({...s, traceability: TRACED}))
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })

    it('completed + docs already done → all-terminal', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
            docsApplicable: true,
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({
                ...s,
                traceability: TRACED,
                docs: {status: 'done', ended_at: DONE_AT},
            }))
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })

    it('failed run (a failed task) → all-terminal, never docs-ready', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
            docsApplicable: true,
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({
                ...t,
                status: 'failed',
                failure_class: 'spec-defect',
                failure_reason: 'x',
                ended_at: DONE_AT,
            }))
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })

    it('docs-suspended run resumes through the gate to docs-ready (status cleared to running)', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
            docsApplicable: true,
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            // Seed a real quota checkpoint so the quota-cleared assertion discriminates
            // (rather than being vacuously true).
            await state.update(runId, (s) => ({
                ...s,
                status: 'suspended',
                quota: {binding_window: '7d' as const, resets_at_epoch: 1_700_018_000},
                traceability: TRACED,
                docs: {status: 'failed', reason: 'prior', ended_at: DONE_AT},
            }))
            expect((await nextTask(deps, runId)).kind).toBe('document')
            const resumed = await state.read(runId)
            expect(resumed.status).toBe('running')
            // the checkpoint clear that returned the run to running must also drop quota
            expect(resumed.quota).toBeUndefined()
        } finally {
            await cleanup()
        }
    })

    it('docs exhausted at MAX_DOCS_ATTEMPTS → finalize, NOT another docs spawn (anti-infinite-loop cap)', async () => {
        // The stop side of next.ts wantsDocs's `attempts >= MAX_DOCS_ATTEMPTS` backstop:
        // an otherwise docs-ready run whose docs phase failed the cap number of times must
        // finalize (docs treated best-effort as done), never re-spawn scribe forever.
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
            docsApplicable: true,
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({
                ...s,
                traceability: TRACED,
                docs: {status: 'failed', reason: 'prior', ended_at: DONE_AT, attempts: MAX_DOCS_ATTEMPTS},
            }))
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })
})

describe('e2e-ready gate (Decision 39)', () => {
    const DONE_AT = '2026-01-01T00:00:00.000Z'
    // Decision 40: an --e2e run passes the run-start assessment gate before any
    // e2e (or work) dispatch — these cases pin the PHASE gate, so mark it done.
    const ASSESSED = {status: 'done' as const, affected_specs: []}

    it('completed + e2e opted-in + phase not yet run → e2e-ready', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({...s, e2e: true, e2e_assessment: ASSESSED}))
            expect((await nextTask(deps, runId)).kind).toBe('e2e')
        } finally {
            await cleanup()
        }
    })

    it('completed + e2e NOT opted-in → falls straight through to finalize (no e2e gate)', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({...s, traceability: TRACED}))
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })

    it('completed + e2e phase already done → skips e2e, proceeds to finalize', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({
                ...s,
                e2e: true,
                traceability: TRACED,
                e2e_phase: {status: 'done', manifest: [], reopen_counts: {}, ended_at: DONE_AT},
            }))
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })

    it('completed + e2e phase failed → finalize directly, never re-enters e2e', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({
                ...s,
                e2e: true,
                e2e_phase: {
                    status: 'failed',
                    reason: 'checkout: cap-exhausted critical',
                    manifest: [],
                    reopen_counts: {},
                    ended_at: DONE_AT,
                },
            }))
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })

    it('e2e precedes docs — a docs-applicable run with e2e still pending gets e2e, not document', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
            docsApplicable: true,
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({...s, e2e: true, e2e_assessment: ASSESSED}))
            expect((await nextTask(deps, runId)).kind).toBe('e2e')
        } finally {
            await cleanup()
        }
    })

    it('a failed e2e phase skips docs too — finalize, not document, even when docs is applicable', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
            docsApplicable: true,
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({
                ...s,
                e2e: true,
                e2e_phase: {
                    status: 'failed',
                    reason: 'unmappable critical regression',
                    manifest: [],
                    reopen_counts: {},
                    ended_at: DONE_AT,
                },
            }))
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })

    it('e2e-cleared-for-reopen run resumes through the quota gate back to e2e (status cleared to running)', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            // e2e_phase.status absent = cleared for a reopen re-fire (manifest/counts persist).
            await state.update(runId, (s) => ({
                ...s,
                e2e: true,
                e2e_assessment: ASSESSED,
                status: 'suspended',
                quota: {binding_window: '7d' as const, resets_at_epoch: 1_700_018_000},
                e2e_phase: {
                    manifest: [{task_ids: ['T1'], spec_path: 'e2e/x.spec.ts', kind: 'critical'}],
                    reopen_counts: {T1: 1},
                },
            }))
            expect((await nextTask(deps, runId)).kind).toBe('e2e')
            const resumed = await state.read(runId)
            expect(resumed.status).toBe('running')
            expect(resumed.quota).toBeUndefined()
        } finally {
            await cleanup()
        }
    })
})

describe('traceability gate (S9, Decision 47)', () => {
    const DONE_AT = '2026-01-01T00:00:00.000Z'

    it('completed run → traceability fires before docs and finalize (universal, no opt-in)', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
            docsApplicable: true,
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            expect((await nextTask(deps, runId)).kind).toBe('traceability')
        } finally {
            await cleanup()
        }
    })

    it('Δ debug run skips traceability — its review⇄fix loop IS the audit (user-confirmed)', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({...s, debug: true}))
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })

    it('traceability done → proceeds to docs', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
            docsApplicable: true,
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({...s, traceability: TRACED}))
            expect((await nextTask(deps, runId)).kind).toBe('document')
        } finally {
            await cleanup()
        }
    })

    it('CONCLUDED failed (unmet verdicts) → finalize, docs skipped even when applicable', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
            docsApplicable: true,
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({
                ...s,
                traceability: {
                    status: 'failed' as const,
                    reason: 'PRD requirements unmet: "returns 201"',
                    verdicts: [{requirement: 'returns 201', verdict: 'unmet' as const, evidence: 'none'}],
                    ended_at: DONE_AT,
                },
            }))
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })

    // The verdicts-presence discriminant (derive-don't-store): failed + empty verdicts +
    // attempts below cap = a CRASH awaiting its retry, not a concluded verdict.
    it('crash-failed below cap → re-fires traceability', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({
                ...s,
                traceability: {
                    status: 'failed' as const,
                    reason: 'auditor died',
                    attempts: 1,
                    verdicts: [],
                    ended_at: DONE_AT,
                },
            }))
            expect((await nextTask(deps, runId)).kind).toBe('traceability')
        } finally {
            await cleanup()
        }
    })

    it('crash-failed AT cap → finalize (concluded — the anti-docs delta)', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({
                ...s,
                traceability: {
                    status: 'failed' as const,
                    reason: 'auditor died twice',
                    attempts: 2,
                    verdicts: [],
                    ended_at: DONE_AT,
                },
            }))
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })

    it('e2e pending precedes traceability', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({
                ...s,
                e2e: true,
                e2e_assessment: {status: 'done' as const, affected_specs: []},
            }))
            expect((await nextTask(deps, runId)).kind).toBe('e2e')
        } finally {
            await cleanup()
        }
    })

    it('a failed e2e phase skips traceability — the run is already condemned', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({
                ...s,
                e2e: true,
                e2e_phase: {
                    status: 'failed' as const,
                    reason: 'cap-exhausted critical',
                    manifest: [],
                    reopen_counts: {},
                    ended_at: DONE_AT,
                },
            }))
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })

    it('trace-suspended run (A2: no quota field) is PARKED — only `factory resume` re-enters traceability (Decision 72)', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            // The crash-suspend leg parks the run suspended WITHOUT a quota checkpoint (A2).
            await state.update(runId, (s) => ({
                ...s,
                status: 'suspended' as const,
                traceability: {
                    status: 'failed' as const,
                    reason: 'auditor died',
                    attempts: 1,
                    verdicts: [],
                    ended_at: DONE_AT,
                },
            }))
            // next-task must NOT silently un-park (the --approve-spec / run-stop hole):
            expect(await nextTask(deps, runId)).toMatchObject({kind: 'pause', scope: 'park'})
            expect((await state.read(runId)).status).toBe('suspended')

            // `factory resume` (planResume clears a quota-less suspend) is the un-park verb;
            // after it, next-task routes back to traceability.
            await state.update(runId, (s) => ({...s, status: 'running' as const}))
            expect((await nextTask(deps, runId)).kind).toBe('traceability')
        } finally {
            await cleanup()
        }
    })

    it('parked run (suspended, no quota, tasks still pending) → pause scope park, status untouched (Decision 72)', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.update(runId, (s) => ({...s, status: 'suspended' as const}))
            const env = await nextTask(deps, runId)
            expect(env).toMatchObject({kind: 'pause', scope: 'park'})
            if (env.kind === 'pause') {
                expect(env.reason).toContain('factory resume')
            }
            expect((await state.read(runId)).status).toBe('suspended')
        } finally {
            await cleanup()
        }
    })
})

describe('e2e-assessment gate (Decision 40)', () => {
    const DONE_AT = '2026-01-01T00:00:00.000Z'

    it('an --e2e run with tasks still pending gets e2e-assessment BEFORE any work', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.update(runId, (s) => ({...s, e2e: true}))
            expect((await nextTask(deps, runId)).kind).toBe('e2e-assessment')
        } finally {
            await cleanup()
        }
    })

    it('a non-e2e run never sees the assessment gate', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps({tasks: [{task_id: 'T1'}]})
        try {
            expect((await nextTask(deps, runId)).kind).toBe('work')
        } finally {
            await cleanup()
        }
    })

    it('assessment done → work proceeds normally', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.update(runId, (s) => ({
                ...s,
                e2e: true,
                e2e_assessment: {status: 'done' as const, affected_specs: []},
            }))
            expect((await nextTask(deps, runId)).kind).toBe('work')
        } finally {
            await cleanup()
        }
    })

    it('all-terminal + e2e phase pending + assessment missing (R11 resume) → e2e-assessment before e2e', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({...s, e2e: true}))
            expect((await nextTask(deps, runId)).kind).toBe('e2e-assessment')
        } finally {
            await cleanup()
        }
    })

    it('a FAILED assessment skips e2e AND docs — straight to finalize', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
            docsApplicable: true,
        })
        try {
            // The record leg swept T1 blocked-environmental; the run heads to finalize.
            await state.updateTask(runId, 'T1', (t) => ({
                ...t,
                status: 'failed',
                failure_class: 'blocked-environmental',
                failure_reason: 'e2e assessment failed: the app cannot boot',
                ended_at: DONE_AT,
            }))
            await state.update(runId, (s) => ({
                ...s,
                e2e: true,
                e2e_assessment: {
                    status: 'failed' as const,
                    reason: 'the app cannot boot',
                    affected_specs: [],
                },
            }))
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })
})

describe('docs ordering invariant', () => {
    const DONE_AT = '2026-01-01T00:00:00.000Z'

    it('docs-ready precedes all-terminal; all-terminal only after docs done', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({
            tasks: [{task_id: 'T1'}],
            docsApplicable: true,
        })
        try {
            await state.updateTask(runId, 'T1', (t) => ({...t, status: 'done', ended_at: DONE_AT}))
            await state.update(runId, (s) => ({...s, traceability: TRACED}))

            // Before docs: the gate withholds all-terminal.
            expect((await nextTask(deps, runId)).kind).toBe('document')

            // Simulate the record marking docs done (Task 5's done path).
            await state.update(runId, (s) => ({...s, docs: {status: 'done', ended_at: DONE_AT}}))

            // Now finalize is reachable.
            expect((await nextTask(deps, runId)).kind).toBe('finalize')
        } finally {
            await cleanup()
        }
    })
})
