/**
 * Tests for the per-task tdd_exempt reader wiring (Δ N).
 *
 * Regression guard: before this wiring the GateContext carried NO exemptReader, so
 * the deterministic TDD gate treated EVERY task as non-exempt — a `tdd_exempt: true`
 * task whose test-writer phase was skipped committed impl-only history and was
 * blocked forever. These tests pin that {@link taskExemptReader} resolves exemption
 * from the durable spec's tasks.json + the worktree's package.json.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {taskExemptReader} from './exempt.js'
import {specDir} from '../core/state/index.js'

const REPO = 'o/n'
const SPEC_ID = '1-x'

let dataDir: string
let worktree: string

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'exempt-data-'))
    worktree = await mkdtemp(join(tmpdir(), 'exempt-wt-'))
})
afterEach(async () => {
    await rm(dataDir, {recursive: true, force: true})
    await rm(worktree, {recursive: true, force: true})
})

/** Write tasks.json (the bare-array canonical form) into the run's durable spec dir. */
async function writeTasks(tasks: unknown): Promise<void> {
    const dir = specDir(dataDir, REPO, SPEC_ID)
    await mkdir(dir, {recursive: true})
    await writeFile(join(dir, 'tasks.json'), JSON.stringify(tasks), 'utf8')
}

function reader() {
    return taskExemptReader({dataDir, spec: {repo: REPO, spec_id: SPEC_ID}}, worktree)
}

describe('taskExemptReader', () => {
    it('reports a task exempt when its tasks.json entry sets tdd_exempt:true', async () => {
        await writeTasks([{task_id: 't1', tdd_exempt: true}])
        expect(await reader().isExempt('t1')).toBe(true)
    })

    it('reports a task NOT exempt when its tasks.json entry omits tdd_exempt', async () => {
        await writeTasks([{task_id: 't1'}])
        expect(await reader().isExempt('t1')).toBe(false)
    })

    it('honors the repo-global package.json factory.tddExempt flag', async () => {
        await writeTasks([{task_id: 't1'}])
        await writeFile(join(worktree, 'package.json'), JSON.stringify({factory: {tddExempt: true}}))
        expect(await reader().isExempt('t1')).toBe(true)
    })

    it('defaults to NOT exempt when the spec dir has no tasks.json (safe default)', async () => {
        expect(await reader().isExempt('t1')).toBe(false)
    })

    it("resolves tasks.json from the run's spec dir, not state.json (derive-don't-store)", async () => {
        await writeTasks([
            {task_id: 't1', tdd_exempt: true},
            {task_id: 't2', tdd_exempt: false},
        ])
        const r = reader()
        expect(await r.isExempt('t1')).toBe(true)
        expect(await r.isExempt('t2')).toBe(false)
    })
})
