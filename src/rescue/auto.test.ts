/**
 * S10 — effectiveAutoResets (the auto-safe filter behind `factory rescue auto`;
 * Decision 48).
 *
 * Pure over {RunState, RescueScan}. The contract these tests pin:
 *   - candidates = scan.resettable (stuck ∪ recoverable) — dead-ends NEVER count,
 *     no matter how actionable;
 *   - a candidate counts only if it is actionable POST-reset: simulate every
 *     candidate → `pending`, then keep a task iff no task in its transitive
 *     depends_on closure remains `failed` or missing. A dead-end dep would just
 *     cascade-fail the reset task again (the reset→re-cascade→re-finalize
 *     no-op burn the filter exists to kill);
 *   - chains of candidates count together (a reset dep simulates to `pending`,
 *     not its stale `failed`/in-flight status);
 *   - empty effective set → [] (the CLI pages instead of resetting).
 */
import {describe, it, expect} from 'vitest'
import {effectiveAutoResets} from './auto.js'
import {scanRun} from './scan.js'
import {parseRunState, isTerminalRunStatus} from '../core/state/index.js'
import type {RunState, RunStatus, TaskState} from '../types/index.js'

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
        return {
            failure_class: 'capability-budget' as const,
            failure_reason: 'ran out of retries',
            ...base,
        }
    }
    return base
}

function mkRun(seeds: readonly TaskSeed[], status: RunStatus = 'failed'): RunState {
    return parseRunState({
        run_id: 'run-auto-1',
        status,
        spec: {repo: 'acme/widgets', spec_id: '7-x', issue_number: 7},
        tasks: Object.fromEntries(seeds.map((s) => [s.task_id, task(s)])),
        started_at: '2026-06-08T00:00:00.000Z',
        updated_at: '2026-06-08T00:00:00.000Z',
        ...(isTerminalRunStatus(status) ? {ended_at: '2026-06-08T01:00:00.000Z'} : {}),
    })
}

function effective(seeds: readonly TaskSeed[], status: RunStatus = 'failed'): string[] {
    const run = mkRun(seeds, status)
    return effectiveAutoResets(run, scanRun(run))
}

describe('effectiveAutoResets', () => {
    it('counts stuck and recoverable candidates whose deps are clean', () => {
        expect(
            effective([
                {task_id: 'done', status: 'done'},
                {task_id: 'stuck', status: 'executing', depends_on: ['done']},
                {task_id: 'recover', status: 'failed', failure_class: 'blocked-environmental'},
            ])
        ).toEqual(['stuck', 'recover'])
    })

    it('excludes a candidate depending on a dead-end (would re-cascade)', () => {
        expect(
            effective([
                {task_id: 'dead', status: 'failed', failure_class: 'spec-defect'},
                {
                    task_id: 'doomed',
                    status: 'failed',
                    failure_class: 'blocked-environmental',
                    depends_on: ['dead'],
                },
                {task_id: 'fine', status: 'executing'},
            ])
        ).toEqual(['fine'])
    })

    it('excludes a candidate whose dead-end dep is TRANSITIVE (through a pending task)', () => {
        expect(
            effective([
                {task_id: 'dead', status: 'failed', failure_class: 'capability-budget'},
                {task_id: 'mid', status: 'pending', depends_on: ['dead']},
                {task_id: 'top', status: 'executing', depends_on: ['mid']},
            ])
        ).toEqual([])
    })

    it('counts a chain of candidates together (a reset dep simulates to pending)', () => {
        // Scan order: stuck first, then recoverable — hence b before a.
        expect(
            effective([
                {task_id: 'a', status: 'failed', failure_class: 'blocked-environmental'},
                {task_id: 'b', status: 'reviewing', depends_on: ['a']},
            ])
        ).toEqual(['b', 'a'])
    })

    it('excludes a candidate with a missing dep', () => {
        expect(effective([{task_id: 'orphan', status: 'executing', depends_on: ['ghost']}])).toEqual([])
    })

    it('never includes dead-ends themselves', () => {
        expect(
            effective([
                {task_id: 'dead-spec', status: 'failed', failure_class: 'spec-defect'},
                {task_id: 'dead-cap', status: 'failed', failure_class: 'capability-budget'},
            ])
        ).toEqual([])
    })

    it('returns empty when nothing is resettable', () => {
        expect(
            effective(
                [
                    {task_id: 'done', status: 'done'},
                    {task_id: 'todo', status: 'pending', depends_on: ['done']},
                ],
                'running'
            )
        ).toEqual([])
    })
})
