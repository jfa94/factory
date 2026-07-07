/**
 * Unit tests for {@link readCurrentForCwd} — the per-repo current-run resolver the
 * human CLI commands share (run-isolation L2.8). Exercised with a {@link FakeGitClient}
 * so repo resolution is deterministic (no real `git` / cwd dependency).
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {readCurrentForCwd, resolveRunIdOrCurrent} from './current.js'
import {parseArgs} from './args.js'
import {StateManager} from '../core/state/index.js'
import {FakeGitClient} from '../git/index.js'
import type {SpecPointer} from '../core/state/index.js'

const specWidgets: SpecPointer = {repo: 'acme/widgets', spec_id: '1-a', issue_number: 1}
const specOther: SpecPointer = {repo: 'acme/other', spec_id: '2-b', issue_number: 2}

/** A FakeGitClient whose origin resolves to `slug` (or no origin when slug is null). */
function git(slug: string | null): FakeGitClient {
    const g = new FakeGitClient()
    if (slug !== null) {
        g.setRemoteUrl('origin', `git@github.com:${slug}.git`)
    }
    return g
}

let dataDir: string
function mgr(): StateManager {
    return new StateManager({
        dataDir,
        lock: {stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50},
    })
}

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'factory-current-'))
})
afterEach(async () => {
    await rm(dataDir, {recursive: true, force: true})
})

describe("readCurrentForCwd — per-repo current run from the caller's checkout", () => {
    it("resolves THIS repo's current run, never another repo's (cross-repo isolation)", async () => {
        const state = mgr()
        await state.create({run_id: 'run-A', staging_branch: 'staging-run-A', spec: specWidgets})
        await state.create({run_id: 'run-B', staging_branch: 'staging-run-B', spec: specOther})

        const inWidgets = await readCurrentForCwd(state, {gitClient: git('acme/widgets'), cwd: '/x'})
        const inOther = await readCurrentForCwd(state, {gitClient: git('acme/other'), cwd: '/y'})
        expect(inWidgets?.run_id).toBe('run-A')
        expect(inOther?.run_id).toBe('run-B')
    })

    it('returns null for a repo with no current run (no cross-repo leak via global)', async () => {
        const state = mgr()
        await state.create({run_id: 'run-A', staging_branch: 'staging-run-A', spec: specWidgets}) // global → run-A
        const found = await readCurrentForCwd(state, {gitClient: git('acme/unrelated'), cwd: '/z'})
        expect(found).toBeNull()
    })

    it("returns null when the repo can't be derived (no origin) — never the global pointer", async () => {
        const state = mgr()
        await state.create({run_id: 'run-A', staging_branch: 'staging-run-A', spec: specWidgets})
        // No origin remote → resolveRepo throws → no repo, no current run.
        const found = await readCurrentForCwd(state, {gitClient: git(null), cwd: '/scratch'})
        expect(found).toBeNull()
    })

    it('returns null when there is no run at all', async () => {
        const state = mgr()
        expect(await readCurrentForCwd(state, {gitClient: git('acme/widgets'), cwd: '/x'})).toBeNull()
    })

    it('rethrows a NON-UsageError from repo resolution (broken git env must not masquerade as "no current run")', async () => {
        const state = mgr()
        const broken = new FakeGitClient()
        broken.remoteUrl = () => Promise.reject(new Error('git: spawn ENOENT'))
        await expect(readCurrentForCwd(state, {gitClient: broken, cwd: '/x'})).rejects.toThrow(/ENOENT/)
    })
})

describe('resolveRunIdOrCurrent — --run flag with current-run fallback', () => {
    it('returns the explicit --run value without touching the store', async () => {
        const state = mgr()
        const id = await resolveRunIdOrCurrent(state, parseArgs(['--run', 'run-X']), 'run finalize', {
            gitClient: git(null),
            cwd: '/x',
        })
        expect(id).toBe('run-X')
    })

    it("falls back to the caller repo's current run", async () => {
        const state = mgr()
        await state.create({run_id: 'run-A', staging_branch: 'staging-run-A', spec: specWidgets})
        const id = await resolveRunIdOrCurrent(state, parseArgs([]), 'rescue apply', {
            gitClient: git('acme/widgets'),
            cwd: '/x',
        })
        expect(id).toBe('run-A')
    })

    it('throws a labeled UsageError when neither --run nor a current run exists', async () => {
        const state = mgr()
        await expect(
            resolveRunIdOrCurrent(state, parseArgs([]), 'rescue apply', {gitClient: git(null), cwd: '/x'})
        ).rejects.toThrow('rescue apply: no --run given and no current run')
    })
})
