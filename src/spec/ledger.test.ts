import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {readLedger, appendLedgerEntries, latestByTask, type LedgerEntry} from './ledger.js'
import {specDir} from '../core/state/paths.js'

const REPO = 'acme/widgets'
const SPEC_ID = '42-checkout'

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
    return {
        task_id: 'T1',
        run_id: 'run-20260716-000000',
        shas: ['abcdef0123456789abcdef0123456789abcdef01'],
        verified_at: '2026-07-16T00:00:00.000Z',
        source: 'shipped',
        ...overrides,
    }
}

describe('spec shipped-ledger (Decision 70)', () => {
    let dataDir: string

    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'factory-ledger-'))
    })

    afterEach(async () => {
        await rm(dataDir, {recursive: true, force: true})
    })

    it('readLedger on a missing file returns an empty ledger (ENOENT is not an error)', async () => {
        expect(await readLedger(dataDir, REPO, SPEC_ID)).toEqual({entries: []})
    })

    it('appendLedgerEntries creates the file and readLedger round-trips it', async () => {
        const e1 = entry({pr_number: 12})
        await appendLedgerEntries(dataDir, REPO, SPEC_ID, [e1])

        expect(await readLedger(dataDir, REPO, SPEC_ID)).toEqual({entries: [e1]})
    })

    it('appendLedgerEntries APPENDS to an existing ledger (never overwrites history)', async () => {
        const e1 = entry()
        const e2 = entry({task_id: 'T2', source: 'already-satisfied'})
        await appendLedgerEntries(dataDir, REPO, SPEC_ID, [e1])
        await appendLedgerEntries(dataDir, REPO, SPEC_ID, [e2])

        expect((await readLedger(dataDir, REPO, SPEC_ID)).entries).toEqual([e1, e2])
    })

    it('readLedger throws LOUD on garbage content (never a silent empty)', async () => {
        const dir = specDir(dataDir, REPO, SPEC_ID)
        await mkdir(dir, {recursive: true})
        await writeFile(join(dir, 'ledger.json'), '{not json')

        await expect(readLedger(dataDir, REPO, SPEC_ID)).rejects.toThrow()
    })

    it('readLedger throws LOUD on a schema-invalid ledger (empty shas)', async () => {
        const dir = specDir(dataDir, REPO, SPEC_ID)
        await mkdir(dir, {recursive: true})
        await writeFile(join(dir, 'ledger.json'), JSON.stringify({entries: [{...entry(), shas: []}]}))

        await expect(readLedger(dataDir, REPO, SPEC_ID)).rejects.toThrow()
    })

    it('latestByTask keeps the LAST entry per task (append order is chronological)', () => {
        const oldT1 = entry({verified_at: '2026-07-01T00:00:00.000Z'})
        const newT1 = entry({verified_at: '2026-07-16T00:00:00.000Z', shas: ['1234567']})
        const t2 = entry({task_id: 'T2'})

        const map = latestByTask({entries: [oldT1, t2, newT1]})

        expect(map.get('T1')).toEqual(newT1)
        expect(map.get('T2')).toEqual(t2)
    })
})
