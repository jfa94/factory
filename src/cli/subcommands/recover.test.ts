/**
 * `factory recover` (S10, Decision 48) — the self-routing repair verb. One test
 * per route (no-run / terminal-nothing / resume / rescue / page), the derived
 * `awaiting` strings, the `reconcile` drift flag, and the `--auto` self-heal leg
 * (recovered + page envelopes, both EXIT.OK; ONE deduped PRD comment).
 *
 * Same harness as rescue.test.ts: an isolated temp data dir via
 * $CLAUDE_PLUGIN_DATA + a real StateManager, stdout captured, fakes from
 * src/git/fakes.ts. FACTORY_AUTONOMOUS_MODE=1 — recover's write routes share
 * `factory resume`'s autonomous-mode gate.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {recoverCommand, runRecover, deriveAwaiting, chooseRoute} from './recover.js'
import {EXIT} from '../../shared/exit-codes.js'
import {at, nonNull} from '../../shared/index.js'
import {StateManager} from '../../core/state/index.js'
import {scanRun} from '../../rescue/index.js'
import {FakeGitClient, FakeGhClient} from '../../git/index.js'
import {selfHealCommentMarker, readMetrics} from '../../scoring/index.js'
import type {SpecPointer, TaskState} from '../../types/index.js'

const SPEC: SpecPointer = {repo: 'acme/widgets', spec_id: '7-x', issue_number: 7}
const RUN = 'run-r'
const AT = '2026-07-04T00:00:00.000Z'

function task(seed: Partial<TaskState> & {task_id: string; status: TaskState['status']}): TaskState {
    const base = {
        depends_on: [],
        risk_tier: 'medium' as const,
        escalation_rung: 0,
        reviewers: [],
        merge_resyncs: 0,
        ...seed,
    }
    if (seed.status === 'failed') {
        return {failure_class: 'capability-budget' as const, failure_reason: 'x', ...base}
    }
    return base
}

describe('factory recover', () => {
    let dataDir: string
    let prevData: string | undefined
    let prevAuto: string | undefined
    let stdout: string[]
    let state: StateManager

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'factory-recover-cli-'))
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
        await state.create({run_id: RUN, spec: SPEC})
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

    it('--help prints help and exits OK', async () => {
        expect(await recoverCommand.run(['--help'])).toBe(EXIT.OK)
    })

    it('--auto with --dry-run is a usage error', async () => {
        expect(await recoverCommand.run(['--auto', '--dry-run'])).toBe(EXIT.USAGE)
    })

    // Route 1 — no run: a routed answer, not an error (safe to fire blind).
    it("routes 'nothing' when no current run resolves", async () => {
        const git = new FakeGitClient()
        git.setRemoteUrl('origin', 'git@github.com:acme/other-repo.git') // no run for this repo
        const code = await runRecover([], {gitClient: git, cwd: '/x'})
        expect(code).toBe(EXIT.OK)
        expect(out()).toEqual({kind: 'nothing', reason: 'no-run'})
    })

    // Route 2 — terminal completed/superseded: nothing to do (+ rollup hint when armed).
    it("routes 'nothing' on a completed run, with a recheck-rollup hint when armed", async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'completed',
            ended_at: AT,
            tasks: {a: task({task_id: 'a', status: 'done'})},
            rollup: {number: 42, merged: false, reason: 'branch policy: merge queued (--auto)'},
        }))
        const code = await recoverCommand.run(['--run', RUN])
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('nothing')
        expect(env.run_status).toBe('completed')
        expect(env.hint).toContain('--recheck-rollup')
    })

    // Route 3 — parked + clean scan: resume, with the DERIVED awaiting cause.
    it('resumes a non-quota park unconditionally (A2) and derives awaiting:spec-approval', async () => {
        // The S9 --approve-spec park: suspended right after create, no task touched.
        await state.update(RUN, (s) => ({
            ...s,
            status: 'suspended',
            tasks: {a: task({task_id: 'a', status: 'pending'})},
        }))
        const code = await recoverCommand.run(['--run', RUN])
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('resumed')
        expect(env.awaiting).toBe('spec-approval')
        expect((await state.read(RUN)).status).toBe('running')
    })

    it('reports a quota park still blocked (fail-closed) with awaiting:quota', async () => {
        // Quota checkpoint present + no readable usage cache in the temp data dir ⇒
        // planResume fail-closes to `pause` — recover reports, never force-clears.
        await state.update(RUN, (s) => ({
            ...s,
            status: 'paused',
            quota: {resets_at_epoch: 4102444800, binding_window: '5h' as const},
            tasks: {a: task({task_id: 'a', status: 'pending'})},
        }))
        const code = await recoverCommand.run(['--run', RUN])
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('pause')
        expect(env.awaiting).toBe('quota')
        expect((await state.read(RUN)).status).toBe('paused')
    })

    it('derives awaiting for docs/e2e/traceability parks (pure)', async () => {
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

    // Route 4 — resettable work: rescue apply + reopen (+ resume when still parked).
    it('rescues resettable work, reopens a failed run, and flags git drift via reconcile', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {
                a: task({task_id: 'a', status: 'executing', branch: `factory/${RUN}/a`}),
                b: task({task_id: 'b', status: 'failed', failure_class: 'blocked-environmental'}),
                c: task({task_id: 'c', status: 'failed', failure_class: 'spec-defect'}),
            },
        }))
        // No staging base, no task branch in the fake ⇒ drift.
        const code = await runRecover(['--run', RUN], {gitClient: new FakeGitClient()})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('rescued')
        expect(env.reset).toEqual(['a', 'b']) // dead-end 'c' untouched
        expect(env.reopened).toBe(true)
        expect(env.reconcile).toBe(true)
        expect(env.resume).toBeUndefined() // reopen already lands on 'running'
        const run = await state.read(RUN)
        expect(run.status).toBe('running')
        expect(nonNull(run.tasks.c).status).toBe('failed')
    })

    it('rescue route reports reconcile:false when the recorded git state is intact', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {
                a: task({task_id: 'a', status: 'executing', branch: `factory/${RUN}/a`}),
            },
        }))
        const git = new FakeGitClient({
            remoteHeads: {[`staging-${RUN}`]: 'sha-base'},
            localBranches: {[`factory/${RUN}/a`]: {sha: 'sha-a'}},
        })
        git.setCommitsAhead(`factory/${RUN}/a`, 2)
        const code = await runRecover(['--run', RUN], {gitClient: git})
        expect(code).toBe(EXIT.OK)
        expect(out().reconcile).toBe(false)
    })

    it('rescue route also clears a surviving park through the resume gate', async () => {
        // A suspended (non-terminal) run WITH stuck work: apply resets the task but the
        // park survives — recover must clear it too, one verb to fully re-activate.
        await state.update(RUN, (s) => ({
            ...s,
            status: 'suspended',
            tasks: {a: task({task_id: 'a', status: 'executing'})},
        }))
        const code = await runRecover(['--run', RUN], {gitClient: new FakeGitClient()})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('rescued')
        expect(env.run_status).toBe('running')
        expect((env.resume as {kind: string}).kind).toBe('resumed')
        expect((await state.read(RUN)).status).toBe('running')
    })

    // Route 5 — dead-ends only: page with per-task hints.
    it('pages on a dead-ends-only run with rescue-apply hints', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {
                a: task({task_id: 'a', status: 'failed', failure_class: 'spec-defect'}),
                b: task({task_id: 'b', status: 'done'}),
            },
        }))
        const code = await recoverCommand.run(['--run', RUN])
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('page')
        expect(env.dead_ends).toEqual(['a'])
        expect(env.hints).toEqual([`factory rescue apply --run ${RUN} --task a --include-dead-ends`])
    })

    it('pages on a traceability-failed run (all tasks done) with a --reset-traceability hint (S9)', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {a: task({task_id: 'a', status: 'done'})},
            traceability: {status: 'failed', reason: 'PRD requirement 3 unmet', verdicts: [], ended_at: AT},
        }))
        const code = await recoverCommand.run(['--run', RUN])
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('page')
        expect(env.hints).toEqual([`factory rescue apply --run ${RUN} --reset-traceability`])
        expect(env.reason).toMatch(/traceability/i)
    })

    it("routes 'nothing' on a healthy running run", async () => {
        await state.update(RUN, (s) => ({
            ...s,
            tasks: {a: task({task_id: 'a', status: 'pending'})},
        }))
        const code = await recoverCommand.run(['--run', RUN])
        expect(code).toBe(EXIT.OK)
        expect(out()).toMatchObject({kind: 'nothing', run_id: RUN, run_status: 'running'})
    })

    // --dry-run: the scan + chosen route, zero writes.
    it('--dry-run emits the scan plus the chosen route and writes nothing', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {
                a: task({task_id: 'a', status: 'failed', failure_class: 'blocked-environmental'}),
            },
        }))
        const code = await runRecover(['--run', RUN, '--dry-run'], {
            gitClient: new FakeGitClient(),
        })
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.route).toBe('rescue')
        expect(env.resettable).toEqual(['a'])
        expect(env.work).toBeDefined()
        expect((await state.read(RUN)).status).toBe('failed') // untouched
    })

    // --auto: the bounded self-heal.
    it('--auto resets the effective set, stamps self_heal, and emits kind:recovered', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {
                a: task({task_id: 'a', status: 'failed', failure_class: 'blocked-environmental'}),
                b: task({task_id: 'b', status: 'failed', failure_class: 'spec-defect'}),
            },
        }))
        const code = await runRecover(['--auto', '--run', RUN], {now: () => AT})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('recovered')
        expect(env.reset).toEqual(['a'])
        expect(env.attempts).toBe(1)
        const run = await state.read(RUN)
        expect(run.self_heal).toEqual({attempts: 1, last_at: AT})
        expect(run.status).toBe('running')
    })

    it('--auto pages (blocked: attempts) and posts ONE deduped PRD comment', async () => {
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
        const code = await runRecover(['--auto', '--run', RUN], {ghClient: gh, now: () => AT})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('page')
        expect(env.reason).toContain('already ran once')
        expect(env.commented).toBe(true)
        expect(gh.issueComments).toHaveLength(1)
        expect(at(gh.issueComments, 0).number).toBe(7)
        expect(at(gh.issueComments, 0).body).toContain(selfHealCommentMarker(RUN))
        // Second blocked auto: the marker dedups — no second comment.
        stdout.length = 0
        expect(await runRecover(['--auto', '--run', RUN], {ghClient: gh, now: () => AT})).toBe(EXIT.OK)
        expect(out().commented).toBe(false)
        expect(gh.issueComments).toHaveLength(1)
    })

    it('--auto pages (blocked: empty) on a dead-ends-only run without stamping self_heal', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {
                a: task({task_id: 'a', status: 'failed', failure_class: 'spec-defect'}),
            },
        }))
        const gh = new FakeGhClient()
        const code = await runRecover(['--auto', '--run', RUN], {ghClient: gh, now: () => AT})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('page')
        expect(env.dead_ends).toEqual(['a'])
        expect(env.commented).toBe(true)
        expect(at(gh.issueComments, 0).body).toContain('`a`')
        const run = await state.read(RUN)
        expect(run.self_heal).toBeUndefined() // a blocked auto never spends the cycle
        expect(run.status).toBe('failed')
    })

    // S11 — the touch ledger: ONE human action = ONE touch, mirrored to metrics.jsonl.
    it("route 3 (resume) appends ONE 'resume' touch and mirrors it to metrics.jsonl", async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'suspended',
            tasks: {a: task({task_id: 'a', status: 'pending'})},
        }))
        const code = await recoverCommand.run(['--run', RUN])
        expect(code).toBe(EXIT.OK)
        const run = await state.read(RUN)
        expect(run.human_touches?.map((t) => t.kind)).toEqual(['resume'])
        const mirrors = (await readMetrics(dataDir, RUN)).filter((m) => m.event === 'human_touch')
        expect(mirrors).toHaveLength(1)
        expect(at(mirrors, 0).data).toEqual({kind: 'resume'})
    })

    it("route 4 (rescue + resume tail) appends exactly ONE 'recover' touch — never a second 'resume'", async () => {
        // Parked + stuck work: the ONE human `factory recover` both resets and clears
        // the park — the ledger must show one touch, not two.
        await state.update(RUN, (s) => ({
            ...s,
            status: 'suspended',
            tasks: {a: task({task_id: 'a', status: 'executing'})},
        }))
        const code = await runRecover(['--run', RUN], {gitClient: new FakeGitClient()})
        expect(code).toBe(EXIT.OK)
        expect(out().kind).toBe('rescued')
        const run = await state.read(RUN)
        expect(run.status).toBe('running')
        expect(run.human_touches?.map((t) => t.kind)).toEqual(['recover'])
        const mirrors = (await readMetrics(dataDir, RUN)).filter((m) => m.event === 'human_touch')
        expect(mirrors.map((m) => m.data)).toEqual([{kind: 'recover'}])
    })

    it('--auto appends NO human touch (self-heal is not a human)', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            status: 'failed',
            ended_at: AT,
            tasks: {
                a: task({task_id: 'a', status: 'failed', failure_class: 'blocked-environmental'}),
            },
        }))
        const code = await runRecover(['--auto', '--run', RUN], {now: () => AT})
        expect(code).toBe(EXIT.OK)
        expect(out().kind).toBe('recovered')
        expect((await state.read(RUN)).human_touches).toBeUndefined()
        expect((await readMetrics(dataDir, RUN)).filter((m) => m.event === 'human_touch')).toHaveLength(0)
    })

    it('chooseRoute prefers rescue over resume when a parked run has resettable work', async () => {
        const base = await state.read(RUN)
        const parked = {
            ...base,
            status: 'suspended' as const,
            tasks: {a: task({task_id: 'a', status: 'executing'})},
        }
        expect(chooseRoute(parked, scanRun(parked))).toBe('rescue')
    })
})
