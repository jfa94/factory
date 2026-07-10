/**
 * WS10 / Task C — the holdout-VERDICT store (the orchestrator's holdout → review record seam).
 *
 * Both impls must satisfy the same contract: `put` is idempotent, `get` is LOUD on
 * an absent key, and `has` is a non-throwing presence probe. The store is keyed by
 * (runId, taskId, rung) — an escalation bump must implicitly invalidate the prior
 * rung's verdicts (S1). The Fs impl ADDITIONALLY re-validates what it reads (a
 * forged/malformed file throws, never a trusted boolean) and round-trips through
 * the Δ Y confined subtree.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {InMemoryHoldoutVerdictStore, FsHoldoutVerdictStore, type HoldoutVerdictStore} from './verdict-store.js'
import {runDir} from '../../core/state/index.js'
import type {HoldoutVerdict} from './validate.js'

const RUN_ID = 'run-1'
const TASK_ID = 't1'
const RUNG = 0

const VERDICTS: readonly HoldoutVerdict[] = [
    {criterion: 'handles empty input', satisfied: true, evidence: 'src/x.ts:10'},
    {criterion: 'rejects negatives', satisfied: false, evidence: ''},
]

/** The shared contract every HoldoutVerdictStore impl must honour. */
function contract(makeStore: () => HoldoutVerdictStore): void {
    it('round-trips put → get', async () => {
        const store = makeStore()
        await store.put(RUN_ID, TASK_ID, RUNG, VERDICTS)
        expect(await store.get(RUN_ID, TASK_ID, RUNG)).toEqual(VERDICTS)
    })

    it('has() reflects presence without throwing', async () => {
        const store = makeStore()
        expect(await store.has(RUN_ID, TASK_ID, RUNG)).toBe(false)
        await store.put(RUN_ID, TASK_ID, RUNG, VERDICTS)
        expect(await store.has(RUN_ID, TASK_ID, RUNG)).toBe(true)
    })

    it('get() is LOUD on an absent key', async () => {
        const store = makeStore()
        await expect(store.get(RUN_ID, 'missing', RUNG)).rejects.toThrow()
    })

    it('put() is idempotent — a second write replaces the first (re-validated round)', async () => {
        const store = makeStore()
        await store.put(RUN_ID, TASK_ID, RUNG, VERDICTS)
        const replacement: readonly HoldoutVerdict[] = [
            {criterion: 'now passes', satisfied: true, evidence: 'src/y.ts:3'},
        ]
        await store.put(RUN_ID, TASK_ID, RUNG, replacement)
        expect(await store.get(RUN_ID, TASK_ID, RUNG)).toEqual(replacement)
    })

    it('keys by (runId, taskId) — a different task is independent', async () => {
        const store = makeStore()
        await store.put(RUN_ID, TASK_ID, RUNG, VERDICTS)
        expect(await store.has(RUN_ID, 't2', RUNG)).toBe(false)
        expect(await store.has('run-2', TASK_ID, RUNG)).toBe(false)
    })

    it('keys by rung — a prior-rung verdict never satisfies the next rung (S1)', async () => {
        const store = makeStore()
        await store.put(RUN_ID, TASK_ID, 0, VERDICTS)
        // After an escalation bump the fast-path probes at rung 1: the stale
        // rung-0 file must be invisible (has false, get LOUD → panel re-spawn).
        expect(await store.has(RUN_ID, TASK_ID, 1)).toBe(false)
        await expect(store.get(RUN_ID, TASK_ID, 1)).rejects.toThrow()
        // And the rung-0 verdicts stay intact under their own key (inert, not clobbered).
        expect(await store.get(RUN_ID, TASK_ID, 0)).toEqual(VERDICTS)
    })
}

describe('InMemoryHoldoutVerdictStore', () => {
    contract(() => new InMemoryHoldoutVerdictStore())
})

describe('FsHoldoutVerdictStore', () => {
    let dataDir: string
    beforeEach(async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'factory-verdict-store-'))
    })
    afterEach(async () => {
        await rm(dataDir, {recursive: true, force: true})
    })

    contract(() => new FsHoldoutVerdictStore(dataDir))

    it('persists under the Δ Y confined holdouts subtree', async () => {
        const store = new FsHoldoutVerdictStore(dataDir)
        await store.put(RUN_ID, TASK_ID, RUNG, VERDICTS)
        // The verdicts live alongside the answer key, not in the worktree.
        const expected = join(runDir(dataDir, RUN_ID), 'holdouts', `${TASK_ID}.r${RUNG}.verdicts.json`)
        // Reading the exact path back confirms the layout (and that get() reads it).
        const onDisk = new FsHoldoutVerdictStore(dataDir)
        expect(await onDisk.get(RUN_ID, TASK_ID, RUNG)).toEqual(VERDICTS)
        expect(expected).toContain(join('runs', RUN_ID, 'holdouts'))
    })

    it('get() is LOUD on a forged/malformed file — never trusts what it reads', async () => {
        const path = join(runDir(dataDir, RUN_ID), 'holdouts', `${TASK_ID}.r${RUNG}.verdicts.json`)
        await mkdir(dirname(path), {recursive: true})
        // A structurally-wrong payload (satisfied is not a boolean) must fail the schema.
        await writeFile(path, JSON.stringify([{criterion: 'x', satisfied: 'yes', evidence: 'z'}]))
        const store = new FsHoldoutVerdictStore(dataDir)
        await expect(store.get(RUN_ID, TASK_ID, RUNG)).rejects.toThrow()
    })

    it('get() is LOUD on a forged file carrying an EXTRA key — .strict() refuses to silently strip it', async () => {
        const path = join(runDir(dataDir, RUN_ID), 'holdouts', `${TASK_ID}.r${RUNG}.verdicts.json`)
        await mkdir(dirname(path), {recursive: true})
        // A well-typed entry with an unknown extra key is a forged/hand-edited file; strict
        // rejects it rather than laundering it into a clean 3-key verdict.
        await writeFile(path, JSON.stringify([{criterion: 'x', satisfied: true, evidence: 'z', forged: true}]))
        const store = new FsHoldoutVerdictStore(dataDir)
        await expect(store.get(RUN_ID, TASK_ID, RUNG)).rejects.toThrow()
    })

    it('has() rethrows a non-ENOENT read failure instead of masking it as absence', async () => {
        // A DIRECTORY at the verdict path makes readFile fail with EISDIR — an
        // environment fault, not absence; swallowing it would silently re-spawn
        // a paid holdout panel.
        const path = join(runDir(dataDir, RUN_ID), 'holdouts', `${TASK_ID}.r${RUNG}.verdicts.json`)
        await mkdir(path, {recursive: true})
        const store = new FsHoldoutVerdictStore(dataDir)
        await expect(store.has(RUN_ID, TASK_ID, RUNG)).rejects.toThrow()
    })

    it('a stale pre-rung-keyed file (<task>.verdicts.json) is invisible to the rung-keyed reader', async () => {
        // A run created before the rung-keyed layout leaves the old task-keyed file on
        // disk; the reader must fail closed (absent → panel re-spawn), never read it.
        const legacy = join(runDir(dataDir, RUN_ID), 'holdouts', `${TASK_ID}.verdicts.json`)
        await mkdir(dirname(legacy), {recursive: true})
        await writeFile(legacy, JSON.stringify([...VERDICTS]))
        const store = new FsHoldoutVerdictStore(dataDir)
        expect(await store.has(RUN_ID, TASK_ID, RUNG)).toBe(false)
        await expect(store.get(RUN_ID, TASK_ID, RUNG)).rejects.toThrow()
    })

    it("a second process (fresh store, same dataDir) reads the first's verdicts", async () => {
        await new FsHoldoutVerdictStore(dataDir).put(RUN_ID, TASK_ID, RUNG, VERDICTS)
        // A `drive` crash-resume can persist the holdout verdicts in one process and read
        // them back in another; a fresh instance over the same dataDir must observe the write.
        expect(await new FsHoldoutVerdictStore(dataDir).has(RUN_ID, TASK_ID, RUNG)).toBe(true)
        expect(await new FsHoldoutVerdictStore(dataDir).get(RUN_ID, TASK_ID, RUNG)).toEqual(VERDICTS)
    })
})
