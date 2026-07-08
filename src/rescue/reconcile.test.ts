/**
 * P1 — GitHub reconcile (read-only facts + drift classification).
 *
 * `classifyDrift` is pure over (RunState, RunFacts), so the classifier tests
 * hand-build facts with NO fakes. The gatherer tests drive `gatherRunFacts`
 * over {@link FakeGhClient} and assert the probe discipline (what is and is
 * NOT called). Multi-PR-per-head classification lives in the PURE tests only:
 * FakeGhClient's PR table holds one PR per head, so multi-PR facts cannot be
 * seeded through it.
 */
import {describe, it, expect} from 'vitest'
import {classifyDrift, gatherRunFacts, reconcileRun} from './reconcile.js'
import type {RunFacts} from './reconcile.js'
import {FakeGhClient} from '../git/fakes.js'
import {parseRunState, isTerminalRunStatus} from '../core/state/index.js'
import type {RunState, RunStatus, TaskState} from '../types/index.js'

type TaskSeed = Partial<TaskState> & {task_id: string; status: TaskState['status']}

const IN_FLIGHT_DEFAULT_PHASE = {executing: 'exec', reviewing: 'verify', shipping: 'ship'} as const

function task(seed: TaskSeed): TaskState {
    const base = {
        depends_on: [],
        risk_tier: 'medium' as const,
        escalation_rung: 0,
        reviewers: [],
        merge_resyncs: 0,
        ...(seed.status === 'executing' || seed.status === 'reviewing' || seed.status === 'shipping'
            ? {phase: IN_FLIGHT_DEFAULT_PHASE[seed.status]}
            : {}),
        ...seed,
    }
    if (seed.status === 'failed') {
        return {failure_class: 'capability-budget' as const, failure_reason: 'ran out of retries', ...base}
    }
    return base
}

function mkRun(seeds: readonly TaskSeed[], status: RunStatus = 'running', rollup?: RunState['rollup']): RunState {
    return parseRunState({
        run_id: 'run-rec-1',
        staging_branch: 'staging-run-rec-1',
        status,
        spec: {repo: 'acme/widgets', spec_id: '7-x', issue_number: 7},
        tasks: Object.fromEntries(seeds.map((s) => [s.task_id, task(s)])),
        started_at: '2026-07-08T00:00:00.000Z',
        updated_at: '2026-07-08T00:00:00.000Z',
        ...(isTerminalRunStatus(status) ? {ended_at: '2026-07-08T01:00:00.000Z'} : {}),
        ...(rollup !== undefined ? {rollup} : {}),
    })
}

/** Facts skeleton the classifier tests overlay. */
function facts(over: Partial<RunFacts>): RunFacts {
    return {
        repo: 'acme/widgets',
        staging: {branch: 'staging-run-rec-1', tip: 'stag1ngsha'},
        tasks: [],
        ...over,
    }
}

const BRANCH = 'factory/run-rec-1/t1'

describe('classifyDrift — per-task classes (pure)', () => {
    it('merged-unrecorded: recorded PR MERGED while the task is not done', () => {
        const run = mkRun([{task_id: 't1', status: 'shipping', branch: BRANCH, pr_number: 101}])
        const drifts = classifyDrift(
            run,
            facts({
                tasks: [
                    {
                        task_id: 't1',
                        branch: BRANCH,
                        recorded_status: 'shipping',
                        recorded_pr_number: 101,
                        prs: [{number: 101, state: 'MERGED', baseRefName: 'staging-run-rec-1', merge_sha: 'abc123'}],
                    },
                ],
            })
        )
        expect(drifts).toHaveLength(1)
        expect(drifts[0]).toMatchObject({
            class: 'merged-unrecorded',
            task_id: 't1',
            pr_number: 101,
            merge_sha: 'abc123',
        })
    })

    it('done tasks are NEVER classified (merged, open under --no-ship, anything)', () => {
        const run = mkRun([{task_id: 't1', status: 'done', branch: BRANCH, pr_number: 101}])
        for (const state of ['MERGED', 'OPEN', 'CLOSED'] as const) {
            const drifts = classifyDrift(
                run,
                facts({
                    tasks: [
                        {
                            task_id: 't1',
                            branch: BRANCH,
                            recorded_status: 'done',
                            recorded_pr_number: 101,
                            prs: [{number: 101, state, baseRefName: 'staging-run-rec-1'}],
                        },
                    ],
                })
            )
            expect(drifts).toEqual([])
        }
    })

    it('closed-unmerged: recorded PR CLOSED while the task still counts on it', () => {
        const run = mkRun([{task_id: 't1', status: 'reviewing', branch: BRANCH, pr_number: 101}])
        const drifts = classifyDrift(
            run,
            facts({
                tasks: [
                    {
                        task_id: 't1',
                        branch: BRANCH,
                        recorded_status: 'reviewing',
                        recorded_pr_number: 101,
                        prs: [{number: 101, state: 'CLOSED', baseRefName: 'staging-run-rec-1'}],
                    },
                ],
            })
        )
        expect(drifts).toHaveLength(1)
        expect(drifts[0]?.class).toBe('closed-unmerged')
    })

    it('a failed task with a CLOSED recorded PR is consistent — no drift', () => {
        const run = mkRun([{task_id: 't1', status: 'failed', branch: BRANCH, pr_number: 101}])
        const drifts = classifyDrift(
            run,
            facts({
                tasks: [
                    {
                        task_id: 't1',
                        branch: BRANCH,
                        recorded_status: 'failed',
                        recorded_pr_number: 101,
                        prs: [{number: 101, state: 'CLOSED', baseRefName: 'staging-run-rec-1'}],
                    },
                ],
            })
        )
        expect(drifts).toEqual([])
    })

    it('stale-pr-number: recorded number matches no PR on the head (lists what the head has)', () => {
        const run = mkRun([{task_id: 't1', status: 'shipping', branch: BRANCH, pr_number: 999}])
        const drifts = classifyDrift(
            run,
            facts({
                tasks: [
                    {
                        task_id: 't1',
                        branch: BRANCH,
                        recorded_status: 'shipping',
                        recorded_pr_number: 999,
                        prs: [{number: 101, state: 'MERGED', baseRefName: 'staging-run-rec-1'}],
                    },
                ],
            })
        )
        expect(drifts).toHaveLength(1)
        expect(drifts[0]?.class).toBe('stale-pr-number')
        expect(drifts[0]?.detail).toContain('#101 MERGED')
    })

    it('pr-unrecorded: OPEN PR on the head with no recorded pr_number', () => {
        const run = mkRun([{task_id: 't1', status: 'executing', branch: BRANCH}])
        const drifts = classifyDrift(
            run,
            facts({
                tasks: [
                    {
                        task_id: 't1',
                        branch: BRANCH,
                        recorded_status: 'executing',
                        prs: [{number: 102, state: 'OPEN', baseRefName: 'staging-run-rec-1'}],
                    },
                ],
            })
        )
        expect(drifts).toHaveLength(1)
        expect(drifts[0]).toMatchObject({class: 'pr-unrecorded', pr_number: 102})
    })

    it('e2e-reopen guard: an unrecorded MERGED PR on the head is NOT drift', () => {
        const run = mkRun([{task_id: 't1', status: 'executing', branch: BRANCH}])
        const drifts = classifyDrift(
            run,
            facts({
                tasks: [
                    {
                        task_id: 't1',
                        branch: BRANCH,
                        recorded_status: 'executing',
                        prs: [{number: 101, state: 'MERGED', baseRefName: 'staging-run-rec-1'}],
                    },
                ],
            })
        )
        expect(drifts).toEqual([])
    })

    it('branch-missing: recorded-OPEN PR whose head branch is gone (probed null)', () => {
        const run = mkRun([{task_id: 't1', status: 'shipping', branch: BRANCH, pr_number: 101}])
        const gone = classifyDrift(
            run,
            facts({
                tasks: [
                    {
                        task_id: 't1',
                        branch: BRANCH,
                        recorded_status: 'shipping',
                        recorded_pr_number: 101,
                        prs: [{number: 101, state: 'OPEN', baseRefName: 'staging-run-rec-1'}],
                        branch_tip: null,
                    },
                ],
            })
        )
        expect(gone).toHaveLength(1)
        expect(gone[0]?.class).toBe('branch-missing')

        const alive = classifyDrift(
            run,
            facts({
                tasks: [
                    {
                        task_id: 't1',
                        branch: BRANCH,
                        recorded_status: 'shipping',
                        recorded_pr_number: 101,
                        prs: [{number: 101, state: 'OPEN', baseRefName: 'staging-run-rec-1'}],
                        branch_tip: 'headsha1',
                    },
                ],
            })
        )
        expect(alive).toEqual([])
    })
})

describe('classifyDrift — run-level classes (pure)', () => {
    it('staging-missing: non-terminal run whose staging tip is null', () => {
        const run = mkRun([{task_id: 't1', status: 'pending'}], 'paused')
        const drifts = classifyDrift(run, facts({staging: {branch: 'staging-run-rec-1', tip: null}}))
        expect(drifts).toHaveLength(1)
        expect(drifts[0]?.class).toBe('staging-missing')
    })

    it('a terminal run with a deleted staging branch is by-design — no drift', () => {
        const run = mkRun([{task_id: 't1', status: 'done'}], 'completed')
        const drifts = classifyDrift(run, facts({staging: {branch: 'staging-run-rec-1', tip: null}}))
        expect(drifts).toEqual([])
    })

    it('rollup-landed: the recorded rollup PR is MERGED despite the merged:false marker', () => {
        const run = mkRun([{task_id: 't1', status: 'done'}], 'completed', {
            number: 900,
            merged: false,
            reason: 'auto-armed',
        })
        const drifts = classifyDrift(
            run,
            facts({
                staging: {branch: 'staging-run-rec-1', tip: null},
                rollup: {
                    recorded_number: 900,
                    prs: [{number: 900, state: 'MERGED', baseRefName: 'develop', merge_sha: 'r0llup'}],
                },
            })
        )
        expect(drifts).toHaveLength(1)
        expect(drifts[0]).toMatchObject({class: 'rollup-landed', pr_number: 900, merge_sha: 'r0llup'})
        expect(drifts[0]?.detail).toContain('--recheck-rollup')
    })

    it('rollup-landed: marker without a number matches ANY merged staging-head PR', () => {
        const run = mkRun([{task_id: 't1', status: 'done'}], 'running', {merged: false, reason: 'no-merge'})
        const drifts = classifyDrift(
            run,
            facts({
                rollup: {prs: [{number: 901, state: 'MERGED', baseRefName: 'develop'}]},
            })
        )
        expect(drifts.map((d) => d.class)).toEqual(['rollup-landed'])
    })

    it('no rollup-landed when the recorded number is not merged (armed, still waiting)', () => {
        const run = mkRun([{task_id: 't1', status: 'done'}], 'completed', {
            number: 900,
            merged: false,
            reason: 'auto-armed',
        })
        const drifts = classifyDrift(
            run,
            facts({
                staging: {branch: 'staging-run-rec-1', tip: 'still-there'},
                rollup: {recorded_number: 900, prs: [{number: 900, state: 'OPEN', baseRefName: 'develop'}]},
            })
        )
        expect(drifts).toEqual([])
    })
})

describe('gatherRunFacts — probe discipline (FakeGhClient)', () => {
    function seededGh(): FakeGhClient {
        const gh = new FakeGhClient()
        gh.remoteBranches.add('staging-run-rec-1')
        gh.branchTips.set('staging-run-rec-1', 'stag1ngsha')
        return gh
    }

    it('probes staging always, prList once per BRANCHED task, and skips branchless tasks', async () => {
        const run = mkRun([
            {task_id: 't1', status: 'shipping', branch: BRANCH, pr_number: 101},
            {task_id: 't2', status: 'pending'},
        ])
        const gh = seededGh()
        gh.setPr({number: 101, headRefName: BRANCH, baseRefName: 'staging-run-rec-1', state: 'MERGED'})
        const result = await gatherRunFacts(run, gh)

        expect(result.staging).toEqual({branch: 'staging-run-rec-1', tip: 'stag1ngsha'})
        expect(result.tasks.map((t) => t.task_id)).toEqual(['t1'])
        expect(gh.calls.filter((c) => c.startsWith('pr list'))).toEqual([`pr list --head ${BRANCH} --state all`])
        expect(result.rollup).toBeUndefined()
    })

    it('probes the task head branch ONLY when the recorded PR is OPEN', async () => {
        const run = mkRun([{task_id: 't1', status: 'shipping', branch: BRANCH, pr_number: 101}])
        const gh = seededGh()
        gh.setPr({number: 101, headRefName: BRANCH, baseRefName: 'staging-run-rec-1', state: 'OPEN'})
        // Head deleted on GitHub → branchTip null → the branch-missing shape.
        const result = await gatherRunFacts(run, gh)
        expect(result.tasks[0]?.branch_tip).toBeNull()

        // Same run, MERGED PR → no head probe at all.
        const gh2 = seededGh()
        gh2.setPr({number: 101, headRefName: BRANCH, baseRefName: 'staging-run-rec-1', state: 'MERGED'})
        const result2 = await gatherRunFacts(run, gh2)
        expect(result2.tasks[0]?.branch_tip).toBeUndefined()
        expect(gh2.calls.filter((c) => c === `api branch ${BRANCH}`)).toEqual([])
    })

    it('gathers rollup facts iff the marker says merged:false, mapping mergeCommit → merge_sha', async () => {
        const withMarker = mkRun([{task_id: 't1', status: 'done'}], 'completed', {
            number: 900,
            merged: false,
            reason: 'auto-armed',
        })
        const gh = seededGh()
        gh.setPr({
            number: 900,
            headRefName: 'staging-run-rec-1',
            baseRefName: 'develop',
            state: 'MERGED',
            mergeCommit: {oid: 'r0llupsha'},
        })
        const result = await gatherRunFacts(withMarker, gh)
        expect(result.rollup).toMatchObject({
            recorded_number: 900,
            prs: [{number: 900, state: 'MERGED', merge_sha: 'r0llupsha'}],
        })

        const noMarker = mkRun([{task_id: 't1', status: 'done'}], 'completed')
        const gh2 = seededGh()
        const result2 = await gatherRunFacts(noMarker, gh2)
        expect(result2.rollup).toBeUndefined()
        expect(gh2.calls.filter((c) => c.startsWith('pr list'))).toEqual([])
    })

    it('is all-or-nothing: a truncated gh payload rejects instead of yielding partial facts', async () => {
        const run = mkRun([{task_id: 't1', status: 'shipping', branch: BRANCH, pr_number: 101}])
        const gh = new FakeGhClient({truncate: true})
        gh.remoteBranches.add('staging-run-rec-1')
        await expect(gatherRunFacts(run, gh)).rejects.toThrow(/TRUNCATED/)
    })
})

describe('reconcileRun — packaged report', () => {
    it('returns facts + drifts + the rollup_landed fold', async () => {
        const run = mkRun([{task_id: 't1', status: 'done'}], 'completed', {
            number: 900,
            merged: false,
            reason: 'auto-armed',
        })
        const gh = new FakeGhClient()
        gh.setPr({number: 900, headRefName: 'staging-run-rec-1', baseRefName: 'develop', state: 'MERGED'})
        const report = await reconcileRun(run, gh)
        expect(report.rollup_landed).toBe(true)
        expect(report.drifts.map((d) => d.class)).toEqual(['rollup-landed'])
        expect(report.facts.staging.tip).toBeNull()
    })
})
