/**
 * WS12 — rescue GC (D55): the orphaned staging-branch/protection sweep.
 *
 * `gcScan` probes GitHub (via the injected GhClient) for every terminal or
 * suspended run whose pinned `staging_branch` still has a live branch or
 * protection rule — the population every other rescue helper deliberately
 * excludes. `gcApply` is the teardown for ONE terminal run: protection first
 * (GitHub blocks deleting a protected ref), then the branch. Consent and the
 * terminal-only refusal live in the CLI layer, not here.
 */
import {describe, it, expect} from 'vitest'
import {gcScan, gcApply} from './gc.js'
import {parseRunState, isTerminalRunStatus} from '../core/state/index.js'
import {FakeGhClient} from '../git/index.js'
import type {RunState, RunStatus} from '../types/index.js'

const AT = '2026-07-01T00:00:00.000Z'

function mkRun(runId: string, status: RunStatus): RunState {
    return parseRunState({
        run_id: runId,
        staging_branch: `staging-${runId}`,
        status,
        spec: {repo: 'acme/widgets', spec_id: '7-x', issue_number: 7},
        tasks: {},
        started_at: AT,
        updated_at: AT,
        ...(isTerminalRunStatus(status) ? {ended_at: AT} : {}),
    })
}

const LIVE_PROTECTION = {
    enabled: true,
    requiredStatusChecks: ['quality-gate'],
    strictUpToDate: true,
    hasMergeQueue: false,
}

/** A fake with a live branch + protection rule for the given run. */
function ghWithLeftover(runId: string): FakeGhClient {
    const gh = new FakeGhClient({protection: {[`staging-${runId}`]: LIVE_PROTECTION}})
    gh.remoteBranches.add(`staging-${runId}`)
    return gh
}

describe('gcScan — detection (read-only)', () => {
    it('reports a superseded run whose branch + protection are still live, with the exact apply hint', async () => {
        const gh = ghWithLeftover('run-a')
        const report = await gcScan([mkRun('run-a', 'superseded')], gh)
        expect(report.findings).toEqual([
            {
                run_id: 'run-a',
                run_status: 'superseded',
                staging_branch: 'staging-run-a',
                branch_exists: true,
                protection_live: true,
                banked: false,
                hint: 'factory rescue gc --apply --run run-a',
            },
        ])
        expect(report.suspended).toEqual([])
        // Read-only: nothing deleted.
        expect(gh.protectionDeletes).toEqual([])
        expect(gh.deletedBranches).toEqual([])
    })

    it('flags a failed run as banked (its branch is deliberately kept for rescue)', async () => {
        const gh = ghWithLeftover('run-f')
        const report = await gcScan([mkRun('run-f', 'failed')], gh)
        expect(report.findings).toHaveLength(1)
        expect(report.findings[0]?.banked).toBe(true)
    })

    it('reports nothing for a clean terminal run (branch and rule both gone)', async () => {
        const gh = new FakeGhClient()
        const report = await gcScan([mkRun('run-b', 'completed')], gh)
        expect(report.findings).toEqual([])
    })

    it('lists a suspended run with a live branch under suspended[] with the cancel --cleanup hint — never as a GC target', async () => {
        const gh = ghWithLeftover('run-s')
        const report = await gcScan([mkRun('run-s', 'suspended')], gh)
        expect(report.findings).toEqual([])
        expect(report.suspended).toEqual([
            {
                run_id: 'run-s',
                staging_branch: 'staging-run-s',
                updated_at: AT,
                hint: 'factory run cancel --run run-s --cleanup',
            },
        ])
    })

    it('skips a clean suspended run (nothing live on GitHub)', async () => {
        const gh = new FakeGhClient()
        const report = await gcScan([mkRun('run-s', 'suspended')], gh)
        expect(report.suspended).toEqual([])
    })

    it('never probes active runs (running/paused are resumable, not GC candidates)', async () => {
        const gh = ghWithLeftover('run-r')
        const report = await gcScan([mkRun('run-r', 'running'), mkRun('run-p', 'paused')], gh)
        expect(report.findings).toEqual([])
        expect(report.suspended).toEqual([])
        expect(gh.calls).toEqual([])
    })
})

describe('gcApply — teardown for ONE terminal run', () => {
    it('deletes protection FIRST, then the branch (GitHub blocks deleting a protected ref)', async () => {
        const gh = ghWithLeftover('run-a')
        const cleaned = await gcApply(mkRun('run-a', 'superseded'), gh)
        expect(cleaned).toEqual({run_id: 'run-a', staging_branch: 'staging-run-a'})
        expect(gh.calls).toEqual(['api DELETE protection staging-run-a', 'api DELETE refs/heads/staging-run-a'])
    })

    it('is idempotent over an already-clean run (both deletes are 404-tolerant no-ops)', async () => {
        const gh = new FakeGhClient()
        await expect(gcApply(mkRun('run-b', 'completed'), gh)).resolves.toEqual({
            run_id: 'run-b',
            staging_branch: 'staging-run-b',
        })
    })

    it('propagates a genuine teardown failure (auth/5xx) instead of masking it', async () => {
        const gh = ghWithLeftover('run-a')
        gh.failDeleteProtection = new Error('HTTP 401: Bad credentials')
        await expect(gcApply(mkRun('run-a', 'superseded'), gh)).rejects.toThrow(/401/)
        expect(gh.deletedBranches).toEqual([]) // branch delete never reached
    })
})
