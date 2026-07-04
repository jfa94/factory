/**
 * WS12 — rescue WORK ASSESSMENT. `assessWork` is pure over an injected
 * {@link WorkProbe}, so these tests script the probe and assert the evidence
 * contract:
 *   - branched non-shipped tasks report branch_exists + commits_ahead above the
 *     run's `origin/staging-<run-id>` base;
 *   - an absent branch → branch_exists:false, commits_ahead:null (count skipped);
 *   - an unresolvable base → base_resolved:false, every commits_ahead:null;
 *   - `done` (shipped) and branchless tasks are skipped;
 *   - a pinned `staging_branch` is honored over the recomputed name.
 */
import {describe, it, expect, vi} from 'vitest'
import {assessWork, type WorkProbe, type TaskWork} from './assess.js'
import {parseRunState, isTerminalRunStatus} from '../core/state/index.js'
import {at} from '../shared/index.js'
import type {RunState, TaskState} from '../types/index.js'

type TaskSeed = Partial<TaskState> & {task_id: string; status: TaskState['status']}

function task(seed: TaskSeed): TaskState {
    const base = {
        depends_on: [],
        risk_tier: 'medium' as const,
        escalation_rung: 0,
        reviewers: [],
        merge_resyncs: 0,
        ...seed,
    }
    if (seed.status === 'failed') {
        return {failure_class: 'spec-defect' as const, failure_reason: 'x', ...base}
    }
    return base
}

function mkRun(seeds: readonly TaskSeed[], extra: Partial<RunState> = {}): RunState {
    const status = extra.status ?? 'failed'
    return parseRunState({
        run_id: 'run-1',
        status,
        spec: {repo: 'acme/widgets', spec_id: '7-x', issue_number: 7},
        tasks: Object.fromEntries(seeds.map((s) => [s.task_id, task(s)])),
        started_at: '2026-06-08T00:00:00.000Z',
        updated_at: '2026-06-08T00:00:00.000Z',
        ...(isTerminalRunStatus(status) ? {ended_at: '2026-06-08T01:00:00.000Z'} : {}),
        ...extra,
    })
}

/**
 * A scriptable probe: a set of resolvable refs + a branch→count table.
 *
 * Return type is inferred (via `satisfies`, not an explicit `: WorkProbe` annotation)
 * so each field stays a plain property (a `vi.fn()` value) rather than adopting
 * `WorkProbe`'s method-shorthand signatures — that keeps `expect(probe.foo)` a property
 * read, not an unbound-method reference.
 */
function makeProbe(refs: Iterable<string>, counts: Record<string, number> = {}) {
    const refSet = new Set(refs)
    return {
        refExists: vi.fn((ref: string) => Promise.resolve(refSet.has(ref))),
        commitsAhead: vi.fn((_base: string, branch: string) => Promise.resolve(counts[branch] ?? 0)),
    } satisfies WorkProbe
}

const BASE = 'origin/staging-run-1'

describe('assessWork', () => {
    it('reports commit counts for branched non-shipped tasks', async () => {
        const run = mkRun([
            {task_id: 'a', status: 'executing', branch: 'factory/run-1/a'},
            {task_id: 'b', status: 'failed', branch: 'factory/run-1/b', pr_number: 42},
        ])
        const probe = makeProbe([BASE, 'factory/run-1/a', 'factory/run-1/b'], {
            'factory/run-1/a': 3,
            'factory/run-1/b': 1,
        })

        const out = await assessWork(run, probe)

        expect(out.base_ref).toBe(BASE)
        expect(out.base_resolved).toBe(true)
        expect(out.tasks).toEqual([
            {task_id: 'a', branch: 'factory/run-1/a', branch_exists: true, commits_ahead: 3},
            {
                task_id: 'b',
                branch: 'factory/run-1/b',
                branch_exists: true,
                commits_ahead: 1,
                pr_number: 42,
            },
        ])
    })

    it('an absent branch reports branch_exists:false, commits_ahead:null (no count attempted)', async () => {
        const run = mkRun([{task_id: 'a', status: 'failed', branch: 'factory/run-1/a'}])
        const probe = makeProbe([BASE]) // base resolves; branch does not

        const out = await assessWork(run, probe)

        expect(out.base_resolved).toBe(true)
        expect(out.tasks).toEqual([
            {task_id: 'a', branch: 'factory/run-1/a', branch_exists: false, commits_ahead: null},
        ])
        expect(probe.commitsAhead).not.toHaveBeenCalled()
    })

    it('an unresolvable base reports base_resolved:false and null counts even for present branches', async () => {
        const run = mkRun([{task_id: 'a', status: 'failed', branch: 'factory/run-1/a'}])
        const probe = makeProbe(['factory/run-1/a']) // branch exists, base does NOT

        const out = await assessWork(run, probe)

        expect(out.base_resolved).toBe(false)
        expect(out.tasks).toEqual([{task_id: 'a', branch: 'factory/run-1/a', branch_exists: true, commits_ahead: null}])
        expect(probe.commitsAhead).not.toHaveBeenCalled()
    })

    it('skips shipped (done) and branchless tasks', async () => {
        const run = mkRun([
            {task_id: 'shipped', status: 'done', branch: 'factory/run-1/shipped'},
            {task_id: 'pending', status: 'pending'}, // no branch
            {task_id: 'stuck', status: 'reviewing', branch: 'factory/run-1/stuck'},
        ])
        const probe = makeProbe([BASE, 'factory/run-1/shipped', 'factory/run-1/stuck'], {
            'factory/run-1/stuck': 2,
        })

        const out = await assessWork(run, probe)

        expect(out.tasks.map((t) => t.task_id)).toEqual(['stuck'])
        expect(at(out.tasks, 0).commits_ahead).toBe(2)
    })

    it('makes the illegal {branch_exists:false, commits_ahead:number} state unrepresentable', () => {
        // A deleted branch carries no commit count; the discriminated union pins the
        // false arm's commits_ahead to null, so this object is a compile error.
        // @ts-expect-error — branch_exists:false forbids a numeric commits_ahead.
        const illegal: TaskWork = {task_id: 'x', branch: 'b', branch_exists: false, commits_ahead: 5}
        expect(illegal.branch_exists).toBe(false)
    })

    it('honors the pinned staging_branch over the recomputed name', async () => {
        const run = mkRun([{task_id: 'a', status: 'failed', branch: 'factory/run-1/a'}], {
            staging_branch: 'staging-custom',
        })
        const probe = makeProbe(['origin/staging-custom', 'factory/run-1/a'], {
            'factory/run-1/a': 5,
        })

        const out = await assessWork(run, probe)

        expect(out.base_ref).toBe('origin/staging-custom')
        expect(out.base_resolved).toBe(true)
        expect(at(out.tasks, 0).commits_ahead).toBe(5)
    })
})
