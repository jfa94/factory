/**
 * `factory next-task` — unit tests for the run-level orchestrator CLI shell.
 *
 * Surfaces:
 *   1. arg/usage edges (short-circuit before wiring) via nextCommand;
 *   2. --run resolution falls back to runs/current;
 *   3. happy-path JSON envelope passthrough via a seeded tmp run.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {writeFile} from 'node:fs/promises'

import {nextCommand, runNextTask} from './next.js'
import {EXIT} from '../../shared/exit-codes.js'
import {captureStream} from '../test-helpers.js'
import {makeOrchestratorDeps, makePrd, makeSpec} from '../../orchestrator/orchestrator-fixtures.js'
import {StateManager} from '../../core/state/manager.js'
import {SpecStore} from '../../spec/index.js'
import {usageCachePath} from '../../quota/index.js'
import {FakeGitClient, FakeGhClient} from '../../git/index.js'

describe('next arg/usage edges', () => {
    it('--help prints help and exits OK', async () => {
        const stdout = captureStream(process.stdout)
        try {
            const code = await nextCommand.run(['--help'])
            expect(code).toBe(EXIT.OK)
            const help = stdout.read()
            // Both the work and finalize lines must mention cascade_failed.
            expect(help).toMatch(/work.*cascade_failed/)
            expect(help).toMatch(/finalize.*cascade_failed/)
        } finally {
            stdout.restore()
        }
    })

    it('no --run with no current run is a usage error', async () => {
        // mkdtemp so StateManager has a valid (but empty) data dir — no current run.
        const dir = await mkdtemp(join(tmpdir(), 'factory-next-empty-'))
        const saved = process.env.CLAUDE_PLUGIN_DATA
        process.env.CLAUDE_PLUGIN_DATA = dir
        const stderr = captureStream(process.stderr)
        try {
            const code = await nextCommand.run([])
            expect(code).toBe(EXIT.USAGE)
            // wrapper prefixes "next-task: "; inner throw has no duplicate prefix
            expect(stderr.read()).toMatch(/^next-task: no --run given/)
        } finally {
            stderr.restore()
            if (saved === undefined) {
                delete process.env.CLAUDE_PLUGIN_DATA
            } else {
                process.env.CLAUDE_PLUGIN_DATA = saved
            }
            await rm(dir, {recursive: true, force: true})
        }
    })
})

describe('next --run resolution falls back to runs/current', () => {
    let dir: string
    let state: StateManager
    let savedEnv: string | undefined

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'factory-next-current-'))
        state = new StateManager({
            dataDir: dir,
            lock: {stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50},
        })
        savedEnv = process.env.CLAUDE_PLUGIN_DATA
        process.env.CLAUDE_PLUGIN_DATA = dir
    })

    afterEach(async () => {
        if (savedEnv === undefined) {
            delete process.env.CLAUDE_PLUGIN_DATA
        } else {
            process.env.CLAUDE_PLUGIN_DATA = savedEnv
        }
        await rm(dir, {recursive: true, force: true})
    })

    it('resolves run_id from runs/current when --run is omitted', async () => {
        // Create a run so it becomes current.
        await state.create({
            run_id: 'run-current',
            staging_branch: 'staging-run-current',
            spec: {repo: 'acme/widgets', spec_id: '42-checkout', issue_number: 42},
        })
        // Seed one pending task so nextTask schedules it.
        await state.update('run-current', (s) => ({
            ...s,
            tasks: {
                T1: {
                    task_id: 'T1',
                    status: 'pending',
                    depends_on: [],
                    risk_tier: 'medium',
                    escalation_rung: 0,
                    reviewers: [],
                    merge_resyncs: 0,
                },
            },
        }))
        // Write the spec to disk — loadOrchestratorDeps -> loadCliDeps -> SpecStore.read requires it.
        const spec = makeSpec([{task_id: 'T1', acceptance_criteria: ['only one']}])
        await new SpecStore({dataDir: dir, docsRoot: join(dir, '_docs')}).write(spec, '# spec', makePrd())

        // Write a zero-usage cache so StatuslineUsageSignal proceeds (not quota-blocked).
        const nowSec = Math.floor(Date.now() / 1000)
        await writeFile(
            usageCachePath(dir),
            JSON.stringify({
                captured_at: nowSec,
                five_hour: {used_percentage: 0, resets_at: nowSec + 18_000},
                seven_day: {used_percentage: 0, resets_at: nowSec + 604_800},
            })
        )

        const stdout = captureStream(process.stdout)
        try {
            const code = await nextCommand.run([]) // no --run
            expect(code).toBe(EXIT.OK)
            const envelope = JSON.parse(stdout.read()) as unknown
            // The envelope self-carries the run context the runner adopts (run_id from
            // runs/current, the canonical data_dir, and the persisted ship_mode
            // default — now `live`).
            expect(envelope).toMatchObject({
                kind: 'work',
                run_id: 'run-current',
                data_dir: dir,
                ship_mode: 'live',
            })
        } finally {
            stdout.restore()
        }
    })
})

describe('next runs/current guards (--assert-owner)', () => {
    let dir: string
    let state: StateManager
    let savedEnv: string | undefined

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'factory-next-owner-'))
        state = new StateManager({
            dataDir: dir,
            lock: {stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50},
        })
        savedEnv = process.env.CLAUDE_PLUGIN_DATA
        process.env.CLAUDE_PLUGIN_DATA = dir
    })

    afterEach(async () => {
        if (savedEnv === undefined) {
            delete process.env.CLAUDE_PLUGIN_DATA
        } else {
            process.env.CLAUDE_PLUGIN_DATA = savedEnv
        }
        await rm(dir, {recursive: true, force: true})
    })

    /** Seed a current run with one ready task + zero-usage cache; optional owner. */
    async function seedReadyCurrent(ownerSession?: string) {
        await state.create({
            run_id: 'run-current',
            staging_branch: 'staging-run-current',
            spec: {repo: 'acme/widgets', spec_id: '42-checkout', issue_number: 42},
            ...(ownerSession !== undefined ? {owner_session: ownerSession} : {}),
        })
        await state.update('run-current', (s) => ({
            ...s,
            tasks: {
                T1: {
                    task_id: 'T1',
                    status: 'pending',
                    depends_on: [],
                    risk_tier: 'medium',
                    escalation_rung: 0,
                    reviewers: [],
                    merge_resyncs: 0,
                },
            },
        }))
        const spec = makeSpec([{task_id: 'T1', acceptance_criteria: ['only one']}])
        await new SpecStore({dataDir: dir, docsRoot: join(dir, '_docs')}).write(spec, '# spec', makePrd())
        const nowSec = Math.floor(Date.now() / 1000)
        await writeFile(
            usageCachePath(dir),
            JSON.stringify({
                captured_at: nowSec,
                five_hour: {used_percentage: 0, resets_at: nowSec + 18_000},
                seven_day: {used_percentage: 0, resets_at: nowSec + 604_800},
            })
        )
    }

    it('throws LOUD when runs/current is owned by a different session', async () => {
        await seedReadyCurrent('sess-A')
        await expect(nextCommand.run(['--assert-owner', 'sess-B'])).rejects.toThrow(
            /owned by session 'sess-A'.*expected 'sess-B'/s
        )
    })

    it('proceeds when the asserted session matches the run owner', async () => {
        await seedReadyCurrent('sess-A')
        const stdout = captureStream(process.stdout)
        try {
            const code = await nextCommand.run(['--assert-owner', 'sess-A'])
            expect(code).toBe(EXIT.OK)
            expect(JSON.parse(stdout.read())).toMatchObject({
                kind: 'work',
                run_id: 'run-current',
            })
        } finally {
            stdout.restore()
        }
    })

    it('degrades safe (no assertion) when the run has no owner_session', async () => {
        await seedReadyCurrent() // owner unknown → cannot assert
        const stdout = captureStream(process.stdout)
        try {
            expect(await nextCommand.run(['--assert-owner', 'sess-B'])).toBe(EXIT.OK)
        } finally {
            stdout.restore()
        }
    })

    it('degrades safe when --assert-owner is empty ($CLAUDE_CODE_SESSION_ID unset)', async () => {
        await seedReadyCurrent('sess-A')
        const stdout = captureStream(process.stdout)
        try {
            expect(await nextCommand.run(['--assert-owner', ''])).toBe(EXIT.OK)
        } finally {
            stdout.restore()
        }
    })

    it('never asserts on the explicit --run path (bypasses runs/current)', async () => {
        await seedReadyCurrent('sess-A')
        const stdout = captureStream(process.stdout)
        try {
            // Mismatched --assert-owner is ignored because --run is explicit.
            expect(await nextCommand.run(['--run', 'run-current', '--assert-owner', 'sess-B'])).toBe(EXIT.OK)
        } finally {
            stdout.restore()
        }
    })

    it('C1 regression: a concurrent create that moved runs/current to a foreign run fails loud, never drives it', async () => {
        // Run A: this session's intended run.
        await state.create({
            run_id: 'run-A',
            staging_branch: 'staging-run-A',
            spec: {repo: 'acme/widgets', spec_id: '42-checkout', issue_number: 42},
            owner_session: 'sess-A',
        })
        // A concurrent create of run B in another session moves runs/current → B.
        await state.create({
            run_id: 'run-B',
            staging_branch: 'staging-run-B',
            spec: {repo: 'acme/other', spec_id: '7-thing', issue_number: 7},
            owner_session: 'sess-B',
        })
        // The runner for A bootstraps with its own session; must fail loud,
        // never silently drive run-B.
        await expect(nextCommand.run(['--assert-owner', 'sess-A'])).rejects.toThrow(
            /owned by session 'sess-B'.*expected 'sess-A'/s
        )
    })
})

describe('next happy path', () => {
    let cleanup: (() => Promise<void>) | undefined

    afterEach(async () => {
        if (cleanup !== undefined) {
            await cleanup()
        }
        cleanup = undefined
    })

    it('emits a work envelope as JSON for a fresh pending task', async () => {
        const {deps, runId, cleanup: c} = await makeOrchestratorDeps()
        cleanup = c

        // Write the spec to disk — loadOrchestratorDeps -> loadCliDeps -> SpecStore.read requires it.
        const spec = makeSpec([{task_id: 'T1', acceptance_criteria: ['only one']}])
        await new SpecStore({dataDir: deps.dataDir, docsRoot: join(deps.dataDir, '_docs')}).write(
            spec,
            '# spec',
            makePrd()
        )

        // Write a zero-usage cache so StatuslineUsageSignal proceeds (not quota-blocked).
        const nowSec = Math.floor(Date.now() / 1000)
        await writeFile(
            usageCachePath(deps.dataDir),
            JSON.stringify({
                captured_at: nowSec,
                five_hour: {used_percentage: 0, resets_at: nowSec + 18_000},
                seven_day: {used_percentage: 0, resets_at: nowSec + 604_800},
            })
        )

        const stdout = captureStream(process.stdout)

        const saved = process.env.CLAUDE_PLUGIN_DATA
        process.env.CLAUDE_PLUGIN_DATA = deps.dataDir
        try {
            const code = await nextCommand.run(['--run', runId])
            expect(code).toBe(EXIT.OK)
            const out = stdout.read()
            expect(out.length).toBeGreaterThan(0)
            const envelope = JSON.parse(out) as {kind: string; run_id: string; ready: readonly string[]}
            expect(envelope).toMatchObject({kind: 'work', run_id: runId})
            expect(envelope.ready).toContain('T1')
        } finally {
            stdout.restore()
            if (saved === undefined) {
                delete process.env.CLAUDE_PLUGIN_DATA
            } else {
                process.env.CLAUDE_PLUGIN_DATA = saved
            }
        }
    })

    it('emits a run-terminal envelope for a run in terminal status', async () => {
        const {
            deps,
            runId,
            cleanup: c,
        } = await makeOrchestratorDeps({
            runStatusOverride: 'completed',
        })
        cleanup = c

        // Write the spec to disk — loadOrchestratorDeps -> loadCliDeps -> SpecStore.read requires it.
        const spec = makeSpec([{task_id: 'T1', acceptance_criteria: ['only one']}])
        await new SpecStore({dataDir: deps.dataDir, docsRoot: join(deps.dataDir, '_docs')}).write(
            spec,
            '# spec',
            makePrd()
        )

        const stdout = captureStream(process.stdout)

        const saved = process.env.CLAUDE_PLUGIN_DATA
        process.env.CLAUDE_PLUGIN_DATA = deps.dataDir
        try {
            const code = await nextCommand.run(['--run', runId])
            expect(code).toBe(EXIT.OK)
            const envelope = JSON.parse(stdout.read()) as unknown
            expect(envelope).toMatchObject({kind: 'done', run_id: runId})
        } finally {
            stdout.restore()
            if (saved === undefined) {
                delete process.env.CLAUDE_PLUGIN_DATA
            } else {
                process.env.CLAUDE_PLUGIN_DATA = saved
            }
        }
    })
})

describe('next-task stale-shipping adoption (Decision 60)', () => {
    let dir: string
    let state: StateManager
    let savedEnv: string | undefined
    const RUN = 'run-ship'
    const STAGING = 'staging-run-ship'

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'factory-next-adopt-'))
        state = new StateManager({
            dataDir: dir,
            lock: {stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50},
        })
        savedEnv = process.env.CLAUDE_PLUGIN_DATA
        process.env.CLAUDE_PLUGIN_DATA = dir
    })

    afterEach(async () => {
        if (savedEnv === undefined) {
            delete process.env.CLAUDE_PLUGIN_DATA
        } else {
            process.env.CLAUDE_PLUGIN_DATA = savedEnv
        }
        await rm(dir, {recursive: true, force: true})
    })

    /** Seed a run with ONE stale in-flight task (aged spawn_in_flight) + zero-usage cache. */
    async function seedStale(status: 'shipping' | 'executing') {
        await state.create({
            run_id: RUN,
            staging_branch: STAGING,
            spec: {repo: 'acme/widgets', spec_id: '42-checkout', issue_number: 42},
        })
        await state.update(RUN, (s) => ({
            ...s,
            tasks: {
                T1: {
                    task_id: 'T1',
                    status,
                    phase: status === 'shipping' ? 'ship' : 'exec',
                    depends_on: [],
                    risk_tier: 'medium',
                    escalation_rung: 0,
                    reviewers: [],
                    merge_resyncs: 0,
                    started_at: '2026-07-08T00:00:00.000Z',
                    // shipping carries a leftover verify-phase checkpoint (only terminal
                    // writers clear it); executing carries its own exec checkpoint. Ancient
                    // spawned_at → past any TTL → `stale`.
                    ...(status === 'shipping' ? {branch: `factory/${RUN}/T1`, pr_number: 101} : {}),
                    spawn_in_flight: {
                        phase: status === 'shipping' ? 'verify' : 'exec',
                        rung: 0,
                        tip_sha: 'x',
                        spawned_at: 1000,
                    },
                },
            },
        }))
        const spec = makeSpec([{task_id: 'T1', acceptance_criteria: ['only one']}])
        await new SpecStore({dataDir: dir, docsRoot: join(dir, '_docs')}).write(spec, '# spec', makePrd())
        const nowSec = Math.floor(Date.now() / 1000)
        await writeFile(
            usageCachePath(dir),
            JSON.stringify({
                captured_at: nowSec,
                five_hour: {used_percentage: 0, resets_at: nowSec + 18_000},
                seven_day: {used_percentage: 0, resets_at: nowSec + 604_800},
            })
        )
    }

    it('adopts a stale SHIPPING task whose PR merged, then recomputes past work', async () => {
        await seedStale('shipping')
        const gh = new FakeGhClient()
        gh.remoteBranches.add(STAGING) // avoid staging-missing noise
        gh.setPr({
            number: 101,
            headRefName: `factory/${RUN}/T1`,
            baseRefName: STAGING,
            state: 'MERGED',
            mergeCommit: {oid: 'sha101'},
            url: 'https://github.com/fake/repo/pull/101',
        })

        const stdout = captureStream(process.stdout)
        try {
            const code = await runNextTask(['--run', RUN], {gitClient: new FakeGitClient(), ghClient: gh})
            expect(code).toBe(EXIT.OK)
            const env = JSON.parse(stdout.read()) as {kind: string; adoption?: {ok: boolean; adopted: string[]}}
            // The merged PR was adopted as done...
            expect(env.adoption?.ok).toBe(true)
            expect(env.adoption?.adopted).toContain('T1')
            // ...the task flipped to done, and the recomputed envelope left `work`.
            expect((await state.read(RUN)).tasks.T1?.status).toBe('done')
            expect(env.kind).not.toBe('work')
        } finally {
            stdout.restore()
        }
    })

    it('degrades on a gh outage: probe returns {ok:false}, task stays shipping, envelope emitted unchanged', async () => {
        await seedStale('shipping')
        const gh = new FakeGhClient({truncate: true}) // every gh read throws "couldn't tell"

        const stdout = captureStream(process.stdout)
        try {
            const code = await runNextTask(['--run', RUN], {gitClient: new FakeGitClient(), ghClient: gh})
            expect(code).toBe(EXIT.OK)
            const env = JSON.parse(stdout.read()) as {kind: string; adoption?: unknown}
            // Outage → no flip: the original work envelope is emitted with NO adoption field,
            // and the task is untouched (the hot runner loop must never crash on a gh outage).
            expect(env.kind).toBe('work')
            expect(env.adoption).toBeUndefined()
            expect((await state.read(RUN)).tasks.T1?.status).toBe('shipping')
        } finally {
            stdout.restore()
        }
    })

    it('does NOT probe gh for a stale NON-shipping (executing) task', async () => {
        await seedStale('executing')
        const gh = new FakeGhClient()

        const stdout = captureStream(process.stdout)
        try {
            const code = await runNextTask(['--run', RUN], {gitClient: new FakeGitClient(), ghClient: gh})
            expect(code).toBe(EXIT.OK)
            const env = JSON.parse(stdout.read()) as {kind: string; stale: string[]; adoption?: unknown}
            // T1 IS stale — proving the gate (status !== shipping), not absence of
            // staleness, is what kept the hot loop probe-free.
            expect(env.stale).toContain('T1')
            expect(env.adoption).toBeUndefined()
            expect(gh.calls.length).toBe(0)
        } finally {
            stdout.restore()
        }
    })
})
