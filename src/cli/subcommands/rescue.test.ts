/**
 * `factory rescue <scan|apply|auto>` — the repair plumbing behind /factory:resume
 * (Decision 50). Arg/usage/help edges; the scan reporter (routes, awaiting,
 * reconcile, hints — the proposed repair plan); the apply writer (`--task`
 * repeat, `--include-dead-ends`, verdict resets, the park-clear tail + ONE
 * 'recover' touch); and the `auto` self-heal leg (recovered + page envelopes,
 * both EXIT.OK; ONE deduped PRD comment).
 *
 * Harness: an isolated temp data dir via $CLAUDE_PLUGIN_DATA + a real
 * StateManager, stdout captured, fakes from src/git/fakes.ts.
 * FACTORY_AUTONOMOUS_MODE=1 — `auto` shares `factory resume`'s gate.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {rescueCommand, runScan, runAuto, runGc, deriveAwaiting, chooseRoute} from './rescue.js'
import {EXIT} from '../../shared/exit-codes.js'
import {at, nonNull} from '../../shared/index.js'
import {StateManager} from '../../core/state/index.js'
import {scanRun} from '../../rescue/index.js'
import {FakeGitClient, FakeGhClient} from '../../git/index.js'
import {selfHealCommentMarker, readMetrics} from '../../scoring/index.js'
import type {SpecPointer, TaskState} from '../../types/index.js'

const SPEC: SpecPointer = {repo: 'acme/widgets', spec_id: '7-x', issue_number: 7}
const RUN = 'run-c'
const AT = '2026-07-04T00:00:00.000Z'

const IN_FLIGHT_DEFAULT_PHASE = {executing: 'exec', reviewing: 'verify', shipping: 'ship'} as const

function task(seed: Partial<TaskState> & {task_id: string; status: TaskState['status']}): TaskState {
    const base = {
        depends_on: [],
        risk_tier: 'medium' as const,
        escalation_rung: 0,
        reviewers: [],
        merge_resyncs: 0,
        ...(seed.status === 'executing' || seed.status === 'reviewing' || seed.status === 'shipping'
            ? {phase: IN_FLIGHT_DEFAULT_PHASE[seed.status]}
            : {}),
        ...seed,
    }
    if (seed.status === 'failed') {
        return {failure_class: 'capability-budget' as const, failure_reason: 'x', ...base}
    }
    return base
}

describe('rescue arg/usage edges', () => {
    it('no action prints help and exits OK', async () => {
        expect(await rescueCommand.run([])).toBe(EXIT.OK)
    })
    it('--help prints help and exits OK', async () => {
        expect(await rescueCommand.run(['--help'])).toBe(EXIT.OK)
    })
    it('scan --help prints help and exits OK', async () => {
        expect(await rescueCommand.run(['scan', '--help'])).toBe(EXIT.OK)
    })
    it('apply --help prints help and exits OK', async () => {
        expect(await rescueCommand.run(['apply', '--help'])).toBe(EXIT.OK)
    })
    it('auto --help prints help and exits OK', async () => {
        expect(await rescueCommand.run(['auto', '--help'])).toBe(EXIT.OK)
    })
    it('gc --help prints help and exits OK', async () => {
        expect(await rescueCommand.run(['gc', '--help'])).toBe(EXIT.OK)
    })
    it('an unknown action is a usage error', async () => {
        expect(await rescueCommand.run(['frobnicate'])).toBe(EXIT.USAGE)
    })
})

describe('rescue scan/apply/auto', () => {
    let dataDir: string
    let prevData: string | undefined
    let prevAuto: string | undefined
    let stdout: string[]
    let state: StateManager

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'factory-rescue-cli-'))
        prevData = process.env.CLAUDE_PLUGIN_DATA
        process.env.CLAUDE_PLUGIN_DATA = dataDir
        prevAuto = process.env.FACTORY_AUTONOMOUS_MODE
        process.env.FACTORY_AUTONOMOUS_MODE = '1'
        stdout = []
        vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
            stdout.push(String(c))
            return true
        })
        state = new StateManager({dataDir})
        await state.create({run_id: RUN, staging_branch: `staging-${RUN}`, spec: SPEC})
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        if (prevData === undefined) {
            delete process.env.CLAUDE_PLUGIN_DATA
        } else {
            process.env.CLAUDE_PLUGIN_DATA = prevData
        }
        if (prevAuto === undefined) {
            delete process.env.FACTORY_AUTONOMOUS_MODE
        } else {
            process.env.FACTORY_AUTONOMOUS_MODE = prevAuto
        }
        await rm(dataDir, {recursive: true, force: true})
    })

    const out = () => JSON.parse(stdout.join('')) as Record<string, unknown>

    /** The mixed fixture: one stuck, one recoverable, one dead-end. */
    async function seedMixed(): Promise<void> {
        await state.update(RUN, (s) => ({
            ...s,
            tasks: {
                a: task({task_id: 'a', status: 'executing'}),
                b: task({task_id: 'b', status: 'failed', failure_class: 'blocked-environmental'}),
                c: task({task_id: 'c', status: 'failed', failure_class: 'spec-defect'}),
            },
        }))
    }

    // ————— scan: the read-only proposed repair plan —————

    it("scan routes 'nothing' when no current run resolves (safe to fire blind)", async () => {
        const git = new FakeGitClient()
        git.setRemoteUrl('origin', 'git@github.com:acme/other-repo.git') // no run for this repo
        const code = await runScan([], {gitClient: git, cwd: '/x'})
        expect(code).toBe(EXIT.OK)
        expect(out()).toEqual({kind: 'nothing', reason: 'no-run', route: 'nothing'})
    })

    it("scan routes 'nothing' on a completed run, with a recheck-rollup hint when armed", async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'completed',
            ended_at: AT,
            tasks: {a: task({task_id: 'a', status: 'done'})},
            rollup: {number: 42, merged: false, reason: 'branch policy: merge queued (--auto)'},
        }))
        const code = await runScan(['--run', RUN], {gitClient: new FakeGitClient()})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.route).toBe('nothing')
        expect(env.run_status).toBe('completed')
        expect(env.hints).toEqual([`factory rescue apply --run ${RUN} --recheck-rollup`])
    })

    it("scan routes 'resume' on a clean park and derives awaiting:spec-approval", async () => {
        // The S9 --approve-spec park: suspended right after create, no task touched.
        await state.update(RUN, (s) => ({
            ...s,
            status: 'suspended',
            tasks: {a: task({task_id: 'a', status: 'pending'})},
        }))
        const code = await runScan(['--run', RUN], {gitClient: new FakeGitClient()})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.route).toBe('resume')
        expect(env.awaiting).toBe('spec-approval')
        expect(env.hints).toEqual([])
        expect((await state.read(RUN)).status).toBe('suspended') // read-only
    })

    it("scan routes 'resume' on a quota park with awaiting:quota (resume owns the gate)", async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'paused',
            quota: {resets_at_epoch: 4102444800, binding_window: '5h' as const},
            tasks: {a: task({task_id: 'a', status: 'pending'})},
        }))
        const code = await runScan(['--run', RUN], {gitClient: new FakeGitClient()})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.route).toBe('resume')
        expect(env.awaiting).toBe('quota')
    })

    it("scan routes 'resume' on a healthy running run (the idempotent re-entry)", async () => {
        await state.update(RUN, (s) => ({
            ...s,
            tasks: {a: task({task_id: 'a', status: 'pending'})},
        }))
        const code = await runScan(['--run', RUN], {gitClient: new FakeGitClient()})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.route).toBe('resume')
        expect(env.awaiting).toBeUndefined() // not parked
    })

    it("scan routes 'repair' on resettable work with the full hint plan + reconcile drift flag", async () => {
        await seedMixed()
        await state.update(RUN, (s) => ({...s, status: 'failed', ended_at: AT}))
        // No staging base, no task branch in the fake ⇒ drift.
        const code = await runScan(['--run', RUN], {gitClient: new FakeGitClient()})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.route).toBe('repair')
        expect(env.resettable).toEqual(['a', 'b'])
        expect(env.dead_ends).toEqual(['c'])
        expect(env.reconcile).toBe(true)
        expect(env.hints).toEqual([
            `factory rescue apply --run ${RUN}`,
            `factory rescue apply --run ${RUN} --task c --include-dead-ends`,
        ])
        expect((await state.read(RUN)).status).toBe('failed') // read-only
    })

    it('scan reports reconcile:false when the recorded git state is intact', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {a: task({task_id: 'a', status: 'executing', branch: `factory/${RUN}/a`})},
        }))
        const git = new FakeGitClient({
            remoteHeads: {[`staging-${RUN}`]: 'sha-base'},
            localBranches: {[`factory/${RUN}/a`]: {sha: 'sha-a'}},
        })
        git.setCommitsAhead(`factory/${RUN}/a`, 2)
        const code = await runScan(['--run', RUN], {gitClient: git})
        expect(code).toBe(EXIT.OK)
        expect(out().reconcile).toBe(false)
    })

    it("scan routes 'repair' on a traceability-failed run (all tasks done) with a --reset-traceability hint (S9)", async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {a: task({task_id: 'a', status: 'done'})},
            traceability: {status: 'failed', reason: 'PRD requirement 3 unmet', verdicts: [], ended_at: AT},
        }))
        const code = await runScan(['--run', RUN], {gitClient: new FakeGitClient()})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.route).toBe('repair')
        expect(env.hints).toEqual([`factory rescue apply --run ${RUN} --reset-traceability`])
    })

    it('scan appends an additive recoverable-work survey from git (work field)', async () => {
        await seedMixed()
        // Give the stuck task a branch carrying committed work above the run's staging base.
        await state.update(RUN, (s) => ({
            ...s,
            tasks: {...s.tasks, a: {...nonNull(s.tasks.a), branch: `factory/${RUN}/a`}},
        }))
        const git = new FakeGitClient({
            remoteHeads: {[`staging-${RUN}`]: 'sha-base'},
            localBranches: {[`factory/${RUN}/a`]: {sha: 'sha-a'}},
        })
        git.setCommitsAhead(`factory/${RUN}/a`, 4)

        const code = await runScan(['--run', RUN], {gitClient: git})
        expect(code).toBe(EXIT.OK)
        const scan = out()
        expect(scan.run_id).toBe(RUN)
        expect(scan.resettable).toEqual(['a', 'b'])
        const work = scan.work as {base_ref: string; base_resolved: boolean; tasks: unknown[]}
        expect(work.base_ref).toBe(`origin/staging-${RUN}`)
        expect(work.base_resolved).toBe(true)
        expect(work.tasks).toEqual([{task_id: 'a', branch: `factory/${RUN}/a`, branch_exists: true, commits_ahead: 4}])
    })

    it('scan defaults to the current run when --run is omitted (resolved per-repo from cwd)', async () => {
        await seedMixed()
        const git = new FakeGitClient()
        git.setRemoteUrl('origin', 'git@github.com:acme/widgets.git')
        const code = await runScan([], {gitClient: git, cwd: '/x'})
        expect(code).toBe(EXIT.OK)
        expect(out().run_id).toBe(RUN)
    })

    it('deriveAwaiting covers docs/e2e/traceability parks and the honest fallback (pure)', async () => {
        const base = await state.read(RUN)
        const parked = {...base, status: 'suspended' as const}
        expect(deriveAwaiting({...parked, docs: {status: 'failed', ended_at: AT}})).toBe('docs')
        expect(
            deriveAwaiting({
                ...parked,
                traceability: {status: 'failed', verdicts: [], ended_at: AT},
            })
        ).toBe('traceability')
        expect(
            deriveAwaiting({
                ...parked,
                e2e_phase: {status: 'failed', manifest: [], reopen_counts: {}},
            })
        ).toBe('e2e')
        // In-flight work + no marker → the honest fallback.
        expect(
            deriveAwaiting({
                ...parked,
                tasks: {a: task({task_id: 'a', status: 'executing'})},
            })
        ).toBe('unknown')
    })

    it("chooseRoute prefers 'repair' over 'resume' when a parked run has resettable work", async () => {
        const base = await state.read(RUN)
        const parked = {
            ...base,
            status: 'suspended' as const,
            tasks: {a: task({task_id: 'a', status: 'executing'})},
        }
        expect(chooseRoute(parked, scanRun(parked))).toBe('repair')
    })

    // ————— apply: the writer —————

    it('apply (default) resets stuck+recoverable, leaving the dead-end', async () => {
        await seedMixed()
        const code = await rescueCommand.run(['apply', '--run', RUN])
        expect(code).toBe(EXIT.OK)
        expect(out().reset).toEqual(['a', 'b'])

        const run = await state.read(RUN)
        expect(nonNull(run.tasks.a).status).toBe('pending')
        expect(nonNull(run.tasks.b).status).toBe('pending')
        expect(nonNull(run.tasks.c).status).toBe('failed') // dead-end left alone
    })

    it('apply --include-dead-ends also resets the dead-end', async () => {
        await seedMixed()
        const code = await rescueCommand.run(['apply', '--run', RUN, '--include-dead-ends'])
        expect(code).toBe(EXIT.OK)
        expect(out().reset).toEqual(['a', 'b', 'c'])
        expect(nonNull((await state.read(RUN)).tasks.c).status).toBe('pending')
    })

    it('apply --reset-e2e clears a failed e2e_phase verdict and reopens the run', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {a: task({task_id: 'a', status: 'done'})},
            e2e_phase: {
                status: 'failed',
                reason: "fail-first proof: 'checkout.spec.ts' is still red against staging",
                manifest: [],
                reopen_counts: {},
            },
        }))
        const code = await rescueCommand.run(['apply', '--run', RUN, '--reset-e2e'])
        expect(code).toBe(EXIT.OK)
        expect(out().reopened).toBe(true)
        const run = await state.read(RUN)
        expect(run.status).toBe('running')
        expect(run.e2e_phase?.status).toBeUndefined()
        expect(run.e2e_phase?.reason).toBeUndefined()
    })

    it('apply --recheck-rollup reopens a completed run whose rollup armed but never landed', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'completed',
            ended_at: AT,
            tasks: {a: task({task_id: 'a', status: 'done'})},
            rollup: {number: 42, merged: false, reason: 'branch policy: merge queued (--auto)'},
        }))
        const code = await rescueCommand.run(['apply', '--run', RUN, '--recheck-rollup'])
        expect(code).toBe(EXIT.OK)
        expect(out().reopened).toBe(true)
        const run = await state.read(RUN)
        expect(run.status).toBe('running')
        // Purely a reopen — finalize re-derives/clears rollup itself; no task touched.
        expect(run.rollup).toEqual({
            number: 42,
            merged: false,
            reason: 'branch policy: merge queued (--auto)',
        })
        expect(nonNull(run.tasks.a).status).toBe('done')
    })

    it('apply --reset-e2e on a NON-terminal run (crash before finalize) still clears the failed e2e_phase', async () => {
        // The run crashed between e2e's markFailed and finalize: status is still
        // "running", so there is nothing to reopen — but the asserted repair must
        // still clear the verdict instead of silently no-oping.
        await state.update(RUN, (s) => ({
            ...s,
            tasks: {a: task({task_id: 'a', status: 'done'})},
            e2e_phase: {
                status: 'failed',
                reason: "fail-first proof: 'checkout.spec.ts' is still red against staging",
                manifest: [{task_ids: ['a'], spec_path: 'e2e/checkout.spec.ts', kind: 'critical' as const}],
                reopen_counts: {},
            },
        }))
        const code = await rescueCommand.run(['apply', '--run', RUN, '--reset-e2e'])
        expect(code).toBe(EXIT.OK)
        expect(out().reopened).toBe(false) // nothing terminal to reopen — but the phase clears
        const run = await state.read(RUN)
        expect(run.status).toBe('running')
        expect(run.e2e_phase?.status).toBeUndefined()
        expect(run.e2e_phase?.manifest).toHaveLength(1) // authored manifest preserved
    })

    it('apply --task selects exactly the named tasks (repeatable)', async () => {
        await seedMixed()
        const code = await rescueCommand.run(['apply', '--run', RUN, '--task', 'a', '--task', 'c'])
        expect(code).toBe(EXIT.OK)
        expect(out().reset).toEqual(['a', 'c']) // explicit dead-end included

        const run = await state.read(RUN)
        expect(nonNull(run.tasks.a).status).toBe('pending')
        expect(nonNull(run.tasks.b).status).toBe('failed') // not named → untouched
        expect(nonNull(run.tasks.c).status).toBe('pending')
    })

    it("apply clears a surviving park through the resume gate with exactly ONE 'recover' touch", async () => {
        // A suspended (non-terminal) run WITH stuck work: the reset alone leaves the
        // park — apply must clear it too (ONE approved plan fully re-activates), and
        // the ledger must show one touch, not a second 'resume' (Decision 49).
        await state.update(RUN, (s) => ({
            ...s,
            status: 'suspended',
            tasks: {a: task({task_id: 'a', status: 'executing'})},
        }))
        const code = await rescueCommand.run(['apply', '--run', RUN])
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.reset).toEqual(['a'])
        expect(env.run_status).toBe('running')
        expect((env.resume as {kind: string}).kind).toBe('resumed')
        const run = await state.read(RUN)
        expect(run.status).toBe('running')
        expect(run.human_touches.map((t) => t.kind)).toEqual(['recover'])
        const mirrors = (await readMetrics(dataDir, RUN)).filter((m) => m.event === 'human_touch')
        expect(mirrors.map((m) => m.data)).toEqual([{kind: 'recover'}])
    })

    // ————— auto: the bounded self-heal —————

    it('auto resets the effective set, stamps self_heal, and emits kind:recovered', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {
                a: task({task_id: 'a', status: 'failed', failure_class: 'blocked-environmental'}),
                b: task({task_id: 'b', status: 'failed', failure_class: 'spec-defect'}),
            },
        }))
        const code = await runAuto(['--run', RUN], {now: () => AT})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('recovered')
        expect(env.reset).toEqual(['a'])
        expect(env.attempts).toBe(1)
        const run = await state.read(RUN)
        expect(run.self_heal).toEqual({attempts: 1, last_at: AT})
        expect(run.status).toBe('running')
    })

    it('auto pages (blocked: attempts) and posts ONE deduped PRD comment', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            self_heal: {attempts: 1, last_at: AT}, // the one cycle already ran
            tasks: {
                a: task({task_id: 'a', status: 'failed', failure_class: 'blocked-environmental'}),
            },
        }))
        const gh = new FakeGhClient()
        const code = await runAuto(['--run', RUN], {ghClient: gh, now: () => AT})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('page')
        expect(env.reason).toContain('already ran once')
        expect(env.commented).toBe(true)
        expect(gh.issueComments).toHaveLength(1)
        expect(at(gh.issueComments, 0).number).toBe(7)
        expect(at(gh.issueComments, 0).body).toContain(selfHealCommentMarker(RUN))
        expect(at(gh.issueComments, 0).body).toContain(`factory rescue scan --run ${RUN}`)
        // Second blocked auto: the marker dedups — no second comment.
        stdout.length = 0
        expect(await runAuto(['--run', RUN], {ghClient: gh, now: () => AT})).toBe(EXIT.OK)
        expect(out().commented).toBe(false)
        expect(gh.issueComments).toHaveLength(1)
    })

    it('auto pages (blocked: empty) on a dead-ends-only run without stamping self_heal', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {
                a: task({task_id: 'a', status: 'failed', failure_class: 'spec-defect'}),
            },
        }))
        const gh = new FakeGhClient()
        const code = await runAuto(['--run', RUN], {ghClient: gh, now: () => AT})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('page')
        expect(env.dead_ends).toEqual(['a'])
        expect(env.hints).toEqual([`factory rescue apply --run ${RUN} --task a --include-dead-ends`])
        expect(env.commented).toBe(true)
        expect(at(gh.issueComments, 0).body).toContain('`a`')
        const run = await state.read(RUN)
        expect(run.self_heal).toBeUndefined() // a blocked auto never spends the cycle
        expect(run.status).toBe('failed')
    })

    it('auto appends NO human touch (self-heal is not a human)', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {
                a: task({task_id: 'a', status: 'failed', failure_class: 'blocked-environmental'}),
            },
        }))
        const code = await runAuto(['--run', RUN], {now: () => AT})
        expect(code).toBe(EXIT.OK)
        expect(out().kind).toBe('recovered')
        expect((await state.read(RUN)).human_touches).toEqual([])
        expect((await readMetrics(dataDir, RUN)).filter((m) => m.event === 'human_touch')).toHaveLength(0)
    })

    // ————— gc: the orphaned staging-branch/protection sweep (D55) —————

    const LIVE_PROTECTION = {
        enabled: true,
        requiredStatusChecks: ['quality-gate'],
        strictUpToDate: true,
        hasMergeQueue: false,
    }

    function ghWithLeftover(): FakeGhClient {
        const gh = new FakeGhClient({protection: {[`staging-${RUN}`]: LIVE_PROTECTION}})
        gh.remoteBranches.add(`staging-${RUN}`)
        return gh
    }

    it('gc reports a terminal run with a live branch+rule, with the exact apply hint (read-only)', async () => {
        await state.update(RUN, (s) => ({...s, status: 'superseded', ended_at: AT, tasks: {}}))
        const gh = ghWithLeftover()
        const code = await runGc([], {ghClient: gh})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('gc')
        expect(env.findings).toEqual([
            {
                run_id: RUN,
                run_status: 'superseded',
                staging_branch: `staging-${RUN}`,
                branch_exists: true,
                protection_live: true,
                banked: false,
                hint: `factory rescue gc --apply --run ${RUN}`,
            },
        ])
        expect(gh.protectionDeletes).toEqual([]) // read-only
    })

    it('gc --apply tears down protection then branch for a terminal run', async () => {
        await state.update(RUN, (s) => ({...s, status: 'superseded', ended_at: AT, tasks: {}}))
        const gh = ghWithLeftover()
        const code = await runGc(['--apply', '--run', RUN], {ghClient: gh})
        expect(code).toBe(EXIT.OK)
        expect(out()).toEqual({kind: 'gc-applied', cleaned: [{run_id: RUN, staging_branch: `staging-${RUN}`}]})
        expect(gh.calls).toEqual([`api DELETE protection staging-${RUN}`, `api DELETE refs/heads/staging-${RUN}`])
    })

    it('gc --apply REFUSES a non-terminal run, pointing at run cancel --cleanup', async () => {
        // RUN is 'running' from create.
        const gh = ghWithLeftover()
        const code = await rescueCommand.run(['gc', '--apply', '--run', RUN])
        expect(code).toBe(EXIT.USAGE)
        expect(gh.protectionDeletes).toEqual([])
    })

    it('gc --apply without --run is a usage error', async () => {
        expect(await rescueCommand.run(['gc', '--apply'])).toBe(EXIT.USAGE)
    })

    it('gc reports a stale (unparseable) run dir under stale[]; --apply sweeps dir + pointer (D57)', async () => {
        const staleId = 'run-stale-v2'
        await mkdir(join(dataDir, 'runs', staleId), {recursive: true})
        await writeFile(
            join(dataDir, 'runs', staleId, 'state.json'),
            JSON.stringify({schema_version: 2, run_id: staleId, staging_branch: `staging-${staleId}`, spec: SPEC})
        )
        const gh = new FakeGhClient()
        gh.remoteBranches.add(`staging-${staleId}`)

        expect(await runGc([], {ghClient: gh})).toBe(EXIT.OK)
        const env = out()
        expect(env.stale).toEqual([
            {
                run_id: staleId,
                reason: 'schema-v2',
                staging_branch: `staging-${staleId}`,
                branch_exists: true,
                protection_live: false,
                hint: `factory rescue gc --apply --run ${staleId}`,
            },
        ])

        stdout.length = 0
        expect(await runGc(['--apply', '--run', staleId], {ghClient: gh})).toBe(EXIT.OK)
        expect(out()).toEqual({
            kind: 'gc-applied',
            cleaned: [],
            stale_cleaned: [{run_id: staleId, staging_branch: `staging-${staleId}`, state_deleted: true}],
        })
        expect(existsSync(join(dataDir, 'runs', staleId))).toBe(false)
        expect(gh.deletedBranches).toEqual([`staging-${staleId}`])
    })

    it('gc lists a suspended run with a live branch under suspended[] with the cancel hint', async () => {
        await state.update(RUN, (s) => ({...s, status: 'suspended', tasks: {}}))
        const gh = ghWithLeftover()
        const code = await runGc([], {ghClient: gh})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.findings).toEqual([])
        const suspended = env.suspended as {run_id: string; hint: string}[]
        expect(suspended).toHaveLength(1)
        expect(at(suspended, 0).run_id).toBe(RUN)
        expect(at(suspended, 0).hint).toBe(`factory run cancel --run ${RUN} --cleanup`)
    })
})
