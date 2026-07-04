/**
 * `factory score` (WS12) — arg/usage edges plus the reporter happy paths through
 * {@link scoreCommand} against an isolated temp data dir ($CLAUDE_PLUGIN_DATA + a
 * real StateManager + SpecStore). Proves the `{kind:"score", summary}` envelope and
 * the default-to-current-run behavior.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {scoreCommand, runScore} from './score.js'
import {EXIT} from '../../shared/exit-codes.js'
import {StateManager} from '../../core/state/index.js'
import {FakeGitClient} from '../../git/index.js'
import {SpecStore} from '../../spec/index.js'
import type {SpecManifest} from '../../spec/index.js'
import type {SpecPointer, TaskState} from '../../types/index.js'
import {makePrd} from '../../orchestrator/orchestrator-fixtures.js'

const REPO = 'acme/widgets'
const SPEC: SpecPointer = {repo: REPO, spec_id: '7-x', issue_number: 7}

const MANIFEST: SpecManifest = {
    spec_id: '7-x',
    issue_number: 7,
    slug: 'x',
    repo: REPO,
    generated_at: '2026-06-08T00:00:00.000Z',
    tasks: [
        {
            task_id: 'a',
            title: 'Task A',
            description: 'do a',
            files: ['src/a.ts'],
            acceptance_criteria: ['a works'],
            tests_to_write: ['test a'],
            depends_on: [],
            risk_tier: 'medium',
            risk_rationale: 'moderate',
        },
        {
            task_id: 'b',
            title: 'Task B',
            description: 'do b',
            files: ['src/b.ts'],
            acceptance_criteria: ['b works'],
            tests_to_write: ['test b'],
            depends_on: [],
            risk_tier: 'low',
            risk_rationale: 'trivial',
        },
    ],
}

describe('score arg/usage edges', () => {
    it('--help prints help and exits OK', async () => {
        expect(await scoreCommand.run(['--help'])).toBe(EXIT.OK)
    })
})

describe('score happy paths', () => {
    let dataDir: string
    let prevEnv: string | undefined
    let stdout: string[]

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
            return {failure_class: 'spec-defect' as const, failure_reason: 'x', ...base}
        }
        return base
    }

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'factory-score-cli-'))
        prevEnv = process.env.CLAUDE_PLUGIN_DATA
        process.env.CLAUDE_PLUGIN_DATA = dataDir
        stdout = []
        vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
            stdout.push(String(c))
            return true
        })

        await new SpecStore({dataDir, docsRoot: join(dataDir, '_docs')}).write(MANIFEST, '# spec', makePrd())
        const state = new StateManager({dataDir})
        await state.create({run_id: 'run-s', spec: SPEC})
        await state.update('run-s', (s) => ({
            ...s,
            status: 'failed',
            ended_at: '2026-06-01T00:00:00.000Z',
            tasks: {
                a: task({task_id: 'a', status: 'done', pr_number: 11, branch: 'factory/run/a'}),
                b: task({task_id: 'b', status: 'failed', failure_class: 'spec-defect'}),
            },
        }))
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        if (prevEnv === undefined) {
            delete process.env.CLAUDE_PLUGIN_DATA
        } else {
            process.env.CLAUDE_PLUGIN_DATA = prevEnv
        }
        await rm(dataDir, {recursive: true, force: true})
    })

    const out = () => JSON.parse(stdout.join('')) as Record<string, unknown>

    it("emits a {kind:'score', summary} envelope", async () => {
        const code = await scoreCommand.run(['--run', 'run-s'])
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('score')

        const summary = env.summary as Record<string, unknown>
        expect(summary.run_id).toBe('run-s')
        expect(summary.run_status).toBe('failed')
        expect(summary.totals).toEqual({total: 2, shipped: 1, failed: 1, incomplete: 0})
        expect(summary.failures_by_class).toEqual({
            'capability-budget': 0,
            'spec-defect': 1,
            'blocked-environmental': 0,
        })
        expect(summary.shipped_prs).toEqual([{task_id: 'a', pr_number: 11, branch: 'factory/run/a'}])
    })

    it('defaults to the current run when --run is omitted (resolved per-repo from cwd)', async () => {
        const git = new FakeGitClient()
        git.setRemoteUrl('origin', `git@github.com:${REPO}.git`)
        const code = await runScore([], {gitClient: git, cwd: '/x'})
        expect(code).toBe(EXIT.OK)
        expect((out().summary as Record<string, unknown>).run_id).toBe('run-s')
    })

    it('exposes the derived touch metric on the summary (S11)', async () => {
        const state = new StateManager({dataDir})
        await state.update('run-s', (s) => ({
            ...s,
            human_touches: [
                {kind: 'launch' as const, at: '2026-06-01T00:00:00.000Z'},
                {kind: 'recover' as const, at: '2026-06-01T01:00:00.000Z'},
            ],
        }))
        await scoreCommand.run(['--run', 'run-s'])
        const summary = out().summary as Record<string, unknown>
        expect(summary.touches).toBe(2)
        expect(summary.touch_metric).toBe(0) // failed run → 0/2
    })
})

describe('score --fleet (S11 — the store-wide touch-metric roll-up)', () => {
    let dataDir: string
    let prevEnv: string | undefined
    let stdout: string[]

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'factory-score-fleet-'))
        prevEnv = process.env.CLAUDE_PLUGIN_DATA
        process.env.CLAUDE_PLUGIN_DATA = dataDir
        stdout = []
        vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
            stdout.push(String(c))
            return true
        })
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        if (prevEnv === undefined) {
            delete process.env.CLAUDE_PLUGIN_DATA
        } else {
            process.env.CLAUDE_PLUGIN_DATA = prevEnv
        }
        await rm(dataDir, {recursive: true, force: true})
    })

    const out = () => JSON.parse(stdout.join('')) as Record<string, unknown>

    async function seedRun(runId: string, status: 'completed' | 'failed', touches: number | null): Promise<void> {
        const state = new StateManager({dataDir})
        await state.create({run_id: runId, spec: SPEC})
        await state.update(runId, (s) => ({
            ...s,
            status,
            ended_at: '2026-06-01T00:00:00.000Z',
            ...(touches !== null
                ? {
                      human_touches: Array.from({length: touches}, (_, i) => ({
                          kind: i === 0 ? ('launch' as const) : ('resume' as const),
                          at: '2026-06-01T00:00:00.000Z',
                      })),
                  }
                : {}),
        }))
    }

    it('rolls up per-run touches + metric and the fleet aggregate; legacy runs are n/a', async () => {
        await seedRun('run-a', 'completed', 2) // 0.5
        await seedRun('run-b', 'failed', 1) // 0
        await seedRun('run-c', 'completed', null) // legacy — excluded from the aggregate

        const code = await scoreCommand.run(['--fleet'])
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('fleet-score')
        const runs = env.runs as Record<string, unknown>[]
        expect(runs).toHaveLength(3)
        expect(runs.find((r) => r.run_id === 'run-a')).toEqual({
            run_id: 'run-a',
            status: 'completed',
            touches: 2,
            metric: 0.5,
        })
        expect(runs.find((r) => r.run_id === 'run-c')).toEqual({
            run_id: 'run-c',
            status: 'completed',
            touches: null,
            metric: null,
        })
        // aggregate = sum(completed with ledger) / sum(touches with ledger) = 1 / 3
        expect(env.aggregate).toBeCloseTo(1 / 3)
    })

    it('skips a malformed run dir (listRuns warns) and aggregates the rest', async () => {
        await seedRun('run-a', 'completed', 1)
        const {mkdir, writeFile} = await import('node:fs/promises')
        await mkdir(join(dataDir, 'runs', 'run-broken'), {recursive: true})
        await writeFile(join(dataDir, 'runs', 'run-broken', 'state.json'), '{not json')

        const code = await scoreCommand.run(['--fleet'])
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect((env.runs as unknown[]).length).toBe(1)
        expect(env.aggregate).toBe(1)
    })

    it('an empty store aggregates to null (no fabricated 0)', async () => {
        const code = await scoreCommand.run(['--fleet'])
        expect(code).toBe(EXIT.OK)
        expect(out()).toEqual({kind: 'fleet-score', runs: [], aggregate: null})
    })
})
