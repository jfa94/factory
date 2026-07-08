/**
 * `factory miss` (Decision 61) — arg/usage edges + the recorder happy paths
 * through {@link missCommand} against an isolated temp data dir. Proves the
 * `{kind:"miss", …}` envelope, per-repo-pointer default, loud validation, the
 * not-done warn, and the append-only (repeats + terminal) ledger semantics.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {missCommand, runMiss} from './miss.js'
import {EXIT} from '../../shared/exit-codes.js'
import {StateManager} from '../../core/state/index.js'
import {FakeGitClient} from '../../git/index.js'
import type {SpecPointer, TaskState} from '../../types/index.js'

const REPO = 'acme/widgets'
const SPEC: SpecPointer = {repo: REPO, spec_id: '7-x', issue_number: 7}

function task(seed: Partial<TaskState> & {task_id: string; status: TaskState['status']}): TaskState {
    return {depends_on: [], escalation_rung: 0, reviewers: [], merge_resyncs: 0, ...seed}
}

describe('miss arg/usage edges', () => {
    it('--help prints help and exits OK', async () => {
        expect(await missCommand.run(['--help'])).toBe(EXIT.OK)
    })
})

describe('miss recorder', () => {
    let dataDir: string
    let prevEnv: string | undefined
    let stdout: string[]
    let stderr: string[]

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'factory-miss-cli-'))
        prevEnv = process.env.CLAUDE_PLUGIN_DATA
        process.env.CLAUDE_PLUGIN_DATA = dataDir
        stdout = []
        stderr = []
        vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
            stdout.push(String(c))
            return true
        })
        vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
            stderr.push(String(c))
            return true
        })

        const state = new StateManager({dataDir})
        await state.create({run_id: 'run-e', staging_branch: 'staging-run-e', spec: SPEC})
        await state.update('run-e', (s) => ({
            ...s,
            tasks: {
                a: task({task_id: 'a', status: 'done', pr_number: 11}),
                b: task({task_id: 'b', status: 'executing', phase: 'exec'}),
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

    it('records a miss and emits {kind:"miss", …} with the new total', async () => {
        const code = await missCommand.run([
            '--run',
            'run-e',
            '--task',
            'a',
            '--note',
            'null deref',
            '--lens',
            'quality-reviewer',
        ])
        expect(code).toBe(EXIT.OK)
        expect(out()).toEqual({kind: 'miss', run_id: 'run-e', task_id: 'a', misses: 1})

        const run = await new StateManager({dataDir}).read('run-e')
        expect(run.misses).toHaveLength(1)
        expect(run.misses[0]).toMatchObject({task_id: 'a', note: 'null deref', lens: 'quality-reviewer'})
        expect(typeof run.misses[0]?.at).toBe('string')
    })

    it('accepts lens "none" and a miss with no lens', async () => {
        expect(await missCommand.run(['--run', 'run-e', '--task', 'a', '--note', 'x', '--lens', 'none'])).toBe(EXIT.OK)
        expect(await missCommand.run(['--run', 'run-e', '--task', 'a', '--note', 'y'])).toBe(EXIT.OK)
        const run = await new StateManager({dataDir}).read('run-e')
        expect(run.misses.map((e) => e.lens)).toEqual(['none', undefined])
    })

    it('defaults to this repo’s current run when --run is omitted (per-repo pointer)', async () => {
        const git = new FakeGitClient()
        git.setRemoteUrl('origin', `git@github.com:${REPO}.git`)
        const code = await runMiss(['--task', 'a', '--note', 'x'], {gitClient: git, cwd: '/x'})
        expect(code).toBe(EXIT.OK)
        expect(out().run_id).toBe('run-e')
    })

    it('unknown --task is loud and lists the run’s task ids', async () => {
        const code = await missCommand.run(['--run', 'run-e', '--task', 'ghost', '--note', 'x'])
        expect(code).toBe(EXIT.USAGE)
        expect(stderr.join('')).toMatch(/unknown --task 'ghost'.*a, b/)
    })

    it('a bad --lens is loud and lists the valid set', async () => {
        const code = await missCommand.run(['--run', 'run-e', '--task', 'a', '--note', 'x', '--lens', 'bogus'])
        expect(code).toBe(EXIT.USAGE)
        expect(stderr.join('')).toMatch(/unknown --lens 'bogus'.*quality-reviewer.*none/)
    })

    it('a missing --note is loud', async () => {
        expect(await missCommand.run(['--run', 'run-e', '--task', 'a'])).toBe(EXIT.USAGE)
        expect(stderr.join('')).toMatch(/requires --note/)
    })

    it('a not-done task warns on stderr but still records', async () => {
        const code = await missCommand.run(['--run', 'run-e', '--task', 'b', '--note', 'x'])
        expect(code).toBe(EXIT.OK)
        expect(stderr.join('')).toMatch(/task 'b' is not 'done'.*recording anyway/)
        expect((await new StateManager({dataDir}).read('run-e')).misses).toHaveLength(1)
    })

    it('repeats append (it is a ledger, dedup is a human problem)', async () => {
        await missCommand.run(['--run', 'run-e', '--task', 'a', '--note', 'x'])
        stdout.length = 0
        const code = await missCommand.run(['--run', 'run-e', '--task', 'a', '--note', 'x'])
        expect(code).toBe(EXIT.OK)
        expect(out().misses).toBe(2)
    })

    it('records on a TERMINAL run (misses surface after finalize)', async () => {
        await new StateManager({dataDir}).update('run-e', (s) => ({
            ...s,
            status: 'completed',
            ended_at: '2026-07-01T00:00:00.000Z',
        }))
        const code = await missCommand.run(['--run', 'run-e', '--task', 'a', '--note', 'x'])
        expect(code).toBe(EXIT.OK)
        expect(out().misses).toBe(1)
    })
})
