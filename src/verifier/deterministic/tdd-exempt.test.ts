/**
 * WS6 — tdd_exempt resolution vectors (Δ N). Ports tdd-gate case4/4b (both
 * tasks.json schemas), package.json.factory.tddExempt, and case_e1 (bare array).
 * NEVER reads state.json (there is no state.json input).
 */
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {DefaultExemptReader, isTddExempt} from './tdd-exempt.js'

describe('isTddExempt (Δ N)', () => {
    it('case4: {tasks:[...]} schema with tdd_exempt:true → exempt', () => {
        const tasks = {tasks: [{task_id: 'task-001', tdd_exempt: true}]}
        expect(isTddExempt('task-001', tasks, null)).toBe(true)
    })

    it('case_e1: bare-array schema with tdd_exempt:true → exempt', () => {
        const tasks = [{task_id: 't1', tdd_exempt: true}]
        expect(isTddExempt('t1', tasks, null)).toBe(true)
    })

    it('package.json.factory.tddExempt globally exempts', () => {
        expect(isTddExempt('anything', null, {factory: {tddExempt: true}})).toBe(true)
    })

    it('non-matching task id is NOT exempt', () => {
        const tasks = {tasks: [{task_id: 'other', tdd_exempt: true}]}
        expect(isTddExempt('task-001', tasks, null)).toBe(false)
    })

    it('tdd_exempt:false / absent is NOT exempt (safe default)', () => {
        expect(isTddExempt('t1', [{task_id: 't1', tdd_exempt: false}], null)).toBe(false)
        expect(isTddExempt('t1', [{task_id: 't1'}], null)).toBe(false)
    })

    it('garbage inputs never accidentally exempt', () => {
        expect(isTddExempt('t1', 'not-json', 42)).toBe(false)
        expect(isTddExempt('t1', null, null)).toBe(false)
        expect(isTddExempt('t1', {tasks: 'nope'}, {factory: 'nope'})).toBe(false)
    })
})

describe('DefaultExemptReader (silent-null hygiene)', () => {
    let dir: string
    let logged: string

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'factory-tdd-exempt-'))
        logged = ''
        vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
            logged += String(chunk)
            return true
        })
    })
    afterEach(() => {
        vi.restoreAllMocks()
        rmSync(dir, {recursive: true, force: true})
    })

    it('missing files (ENOENT) are a silent not-exempt — no warn', async () => {
        const reader = new DefaultExemptReader({specDir: dir, worktree: dir})
        expect(await reader.isExempt('t1')).toBe(false)
        expect(logged).toBe('')
    })

    it('an EXISTING but corrupt tasks.json warns loudly, naming the file', async () => {
        writeFileSync(join(dir, 'tasks.json'), '{not json!!')
        const reader = new DefaultExemptReader({specDir: dir, worktree: dir})
        expect(await reader.isExempt('t1')).toBe(false)
        expect(logged).toMatch(/could not parse/)
        expect(logged).toContain(join(dir, 'tasks.json'))
    })
})
