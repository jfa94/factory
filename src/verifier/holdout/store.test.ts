/**
 * WS10 (holdout, Δ Y) — answer-key store: round-trip, idempotent overwrite,
 * absence is LOUD, schema validation, and the confined `holdouts/` path.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {runDir} from '../../core/state/index.js'
import {
    FsHoldoutStore,
    InMemoryHoldoutStore,
    makeHoldoutRecord,
    parseHoldoutRecord,
    type HoldoutStore,
} from './store.js'

function contractFor(name: string, make: () => HoldoutStore) {
    describe(name, () => {
        it('round-trips a record', async () => {
            const store = make()
            const rec = makeHoldoutRecord('task-1', ['x', 'y'], 5)
            await store.put('run-1', rec)
            expect(await store.get('run-1', 'task-1')).toEqual(rec)
            expect(await store.has('run-1', 'task-1')).toBe(true)
        })

        it('overwrites idempotently (a retried split is safe)', async () => {
            const store = make()
            await store.put('run-1', makeHoldoutRecord('task-1', ['x'], 3))
            await store.put('run-1', makeHoldoutRecord('task-1', ['y', 'z'], 4))
            expect((await store.get('run-1', 'task-1')).withheld_criteria).toEqual(['y', 'z'])
        })

        it('is LOUD when the key is absent', async () => {
            const store = make()
            expect(await store.has('run-1', 'ghost')).toBe(false)
            await expect(store.get('run-1', 'ghost')).rejects.toThrow()
        })

        it('isolates by run id', async () => {
            const store = make()
            await store.put('run-A', makeHoldoutRecord('task-1', ['a'], 2))
            expect(await store.has('run-B', 'task-1')).toBe(false)
        })
    })
}

contractFor('InMemoryHoldoutStore', () => new InMemoryHoldoutStore())

describe('FsHoldoutStore', () => {
    let dataDir: string
    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'holdout-store-'))
    })
    afterEach(async () => {
        await rm(dataDir, {recursive: true, force: true})
    })

    contractFor('FsHoldoutStore (contract)', () => new FsHoldoutStore(dataDir))

    it('writes under the Δ Y-confined runs/<run>/holdouts/<task>.json path', async () => {
        const store = new FsHoldoutStore(dataDir)
        await store.put('run-1', makeHoldoutRecord('task-1', ['x'], 2))
        const {readFile} = await import('node:fs/promises')
        const path = join(runDir(dataDir, 'run-1'), 'holdouts', 'task-1.json')
        const onDisk = parseHoldoutRecord(JSON.parse(await readFile(path, 'utf8')), path)
        expect(onDisk.task_id).toBe('task-1')
    })
})

describe('parseHoldoutRecord', () => {
    it('accepts a well-formed record', () => {
        const rec = makeHoldoutRecord('t', ['a', 'b'], 4)
        expect(parseHoldoutRecord(rec)).toEqual(rec)
    })

    it('rejects a count/array-length mismatch (forged answer key)', () => {
        expect(() =>
            parseHoldoutRecord({
                task_id: 't',
                withheld_criteria: ['a', 'b'],
                total_criteria: 4,
                withheld_count: 5,
            })
        ).toThrow(/withheld_count/)
    })

    it('rejects unknown keys (.strict)', () => {
        expect(() =>
            parseHoldoutRecord({
                task_id: 't',
                withheld_criteria: [],
                total_criteria: 0,
                withheld_count: 0,
                sneaky: true,
            })
        ).toThrow()
    })
})
