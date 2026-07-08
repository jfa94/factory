/**
 * `factory reconcile` — the GitHub-truth reporter (P1, read-only slice).
 * Envelope shape; loud gh failure (unlike scan's contained `github` section);
 * run resolution edges. Harness: temp $CLAUDE_PLUGIN_DATA + real StateManager,
 * stdout captured, FakeGhClient.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {reconcileCommand, runReconcile} from './reconcile.js'
import {EXIT} from '../../shared/exit-codes.js'
import {StateManager} from '../../core/state/index.js'
import {FakeGhClient, FakeGitClient} from '../../git/index.js'
import type {SpecPointer, TaskState} from '../../types/index.js'

const SPEC: SpecPointer = {repo: 'acme/widgets', spec_id: '7-x', issue_number: 7}
const RUN = 'run-rec'

function task(seed: Partial<TaskState> & {task_id: string; status: TaskState['status']}): TaskState {
    return {
        depends_on: [],
        escalation_rung: 0,
        reviewers: [],
        merge_resyncs: 0,
        ...(seed.status === 'shipping' ? {phase: 'ship'} : {}),
        ...seed,
    }
}

describe('factory reconcile (read-only GitHub-truth reporter)', () => {
    let dataDir: string
    let prevData: string | undefined
    let stdout: string[]
    let state: StateManager

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'factory-reconcile-cli-'))
        prevData = process.env.CLAUDE_PLUGIN_DATA
        process.env.CLAUDE_PLUGIN_DATA = dataDir
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
        await rm(dataDir, {recursive: true, force: true})
    })

    const out = () => JSON.parse(stdout.join('')) as Record<string, unknown>

    it('--help prints help and exits OK', async () => {
        expect(await reconcileCommand.run(['--help'])).toBe(EXIT.OK)
    })

    it('emits the {kind:"reconcile"} envelope with facts + classified drift', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            tasks: {
                a: task({task_id: 'a', status: 'shipping', branch: `factory/${RUN}/a`, pr_number: 101}),
            },
        }))
        const gh = new FakeGhClient()
        gh.remoteBranches.add(`staging-${RUN}`)
        gh.branchTips.set(`staging-${RUN}`, 'stagsha')
        gh.setPr({
            number: 101,
            headRefName: `factory/${RUN}/a`,
            baseRefName: `staging-${RUN}`,
            state: 'MERGED',
            mergeCommit: {oid: 'mergedsha'},
        })
        const code = await runReconcile(['--run', RUN], {ghClient: gh})
        expect(code).toBe(EXIT.OK)
        const env = out()
        expect(env.kind).toBe('reconcile')
        expect(env.run_id).toBe(RUN)
        expect(env.run_status).toBe('running')
        expect(env.facts).toMatchObject({repo: 'acme/widgets', staging: {branch: `staging-${RUN}`, tip: 'stagsha'}})
        expect(env.drifts).toEqual([
            expect.objectContaining({class: 'merged-unrecorded', task_id: 'a', merge_sha: 'mergedsha'}),
        ])
        expect(env.rollup_landed).toBe(false)
        expect((await state.read(RUN)).status).toBe('running') // read-only
    })

    it('--adopt applies the forward-only repairs against the same report (records the merged PR done)', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            tasks: {
                a: task({task_id: 'a', status: 'shipping', branch: `factory/${RUN}/a`, pr_number: 101}),
            },
        }))
        const gh = new FakeGhClient()
        gh.remoteBranches.add(`staging-${RUN}`)
        gh.branchTips.set(`staging-${RUN}`, 'stagsha')
        gh.setPr({
            number: 101,
            headRefName: `factory/${RUN}/a`,
            baseRefName: `staging-${RUN}`,
            state: 'MERGED',
            mergeCommit: {oid: 'mergedsha'},
        })
        const code = await runReconcile(['--run', RUN, '--adopt'], {ghClient: gh, gitClient: new FakeGitClient()})
        expect(code).toBe(EXIT.OK)
        const env = out()
        // The same drift is still reported...
        expect(env.drifts).toEqual([expect.objectContaining({class: 'merged-unrecorded', task_id: 'a'})])
        // ...AND the adoption field carries what was applied.
        expect(env.adoption).toMatchObject({ok: true, adopted: ['a'], changed: true})
        // The write actually landed (unlike the read-only path).
        expect((await state.read(RUN)).tasks.a?.status).toBe('done')
    })

    it('fails LOUD on a gh failure (facts are the whole job — no contained {ok:false} arm)', async () => {
        await state.update(RUN, (s) => ({
            ...s,
            tasks: {a: task({task_id: 'a', status: 'shipping', branch: `factory/${RUN}/a`, pr_number: 101})},
        }))
        const gh = new FakeGhClient({truncate: true})
        gh.remoteBranches.add(`staging-${RUN}`)
        await expect(runReconcile(['--run', RUN], {ghClient: gh})).rejects.toThrow(/TRUNCATED/)
    })

    it('no --run and no current run is a usage error (EXIT.USAGE via the guard)', async () => {
        const git = new FakeGitClient()
        git.setRemoteUrl('origin', 'git@github.com:acme/other-repo.git') // no run for this repo
        await expect(runReconcile([], {ghClient: new FakeGhClient(), gitClient: git, cwd: '/x'})).rejects.toThrow(
            /no --run given and no current run/
        )
    })
})
