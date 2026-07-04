/**
 * `appendTasksFromSpec` (Decision 39 rebuild, Task 5) — pass-N task appending
 * onto an existing run's task set. Mirrors `seedTasksFromSpec`'s validation
 * (`src/cli/subcommands/run.test.ts`), plus the `p<passNumber>-` namespacing
 * that lets repeated debug passes reuse spec-generator task ids without
 * colliding.
 */
import {describe, it, expect} from 'vitest'
import {appendTasksFromSpec} from './batch.js'
import {parseSpecManifest, type SpecManifest} from '../spec/index.js'
import type {TaskState} from '../types/index.js'
import {nonNull} from '../shared/index.js'

const REPO = 'acme/widgets'

/** Build one durable spec task with overridable fields. */
function task(id: string, deps: string[] = [], opts: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        task_id: id,
        title: `task ${id}`,
        description: `does ${id}`,
        files: [`src/${id}.ts`],
        acceptance_criteria: ['a'],
        tests_to_write: ['covers it'],
        depends_on: deps,
        risk_tier: 'medium',
        risk_rationale: 'moderate',
        ...opts,
    }
}

/** A durable spec request over the given tasks. */
function request(tasks: readonly Record<string, unknown>[], specId = '42-checkout'): SpecManifest {
    return parseSpecManifest({
        spec_id: specId,
        issue_number: 42,
        slug: 'checkout',
        repo: REPO,
        generated_at: '2026-06-01T00:00:00.000Z',
        tasks,
    })
}

describe('appendTasksFromSpec', () => {
    it('pass-1 batch with no existing tasks behaves like seedTasksFromSpec plus the p1- prefix', () => {
        const seeded = appendTasksFromSpec(
            {},
            request([task('t1', [], {risk_tier: 'low'}), task('t2', ['t1'], {risk_tier: 'high'})]),
            1
        )

        expect(Object.keys(seeded).sort()).toEqual(['p1-t1', 'p1-t2'])
        expect(seeded['p1-t1']).toEqual({
            task_id: 'p1-t1',
            status: 'pending',
            depends_on: [],
            escalation_rung: 0,
            reviewers: [],
            merge_resyncs: 0,
        })
        expect(nonNull(seeded['p1-t2']).depends_on).toEqual(['p1-t1'])
    })

    it("pass-2 batch appended onto pass-1's terminal tasks — union has both, no collision", () => {
        const pass1: Record<string, TaskState> = {
            'p1-t1': {
                task_id: 'p1-t1',
                status: 'done',
                depends_on: [],
                escalation_rung: 0,
                reviewers: [],
                merge_resyncs: 0,
            },
        }

        const merged = appendTasksFromSpec(pass1, request([task('t1', []), task('t2', ['t1'])]), 2)

        expect(Object.keys(merged).sort()).toEqual(['p1-t1', 'p2-t1', 'p2-t2'])
        // pass-1's already-terminal task is untouched.
        expect(nonNull(merged['p1-t1']).status).toBe('done')
        // pass-2's tasks are fresh pending rows, internally namespaced.
        expect(nonNull(merged['p2-t1']).status).toBe('pending')
        expect(nonNull(merged['p2-t2']).depends_on).toEqual(['p2-t1'])
    })

    it('is LOUD on a same-batch dependency cycle', () => {
        expect(() => appendTasksFromSpec({}, request([task('t1', ['t2']), task('t2', ['t1'])]), 1)).toThrow(
            /dependency cycle/
        )
    })

    it('is LOUD on a dangling same-batch dependency', () => {
        expect(() => appendTasksFromSpec({}, request([task('t1', ['ghost'])]), 1)).toThrow(/unknown task 'ghost'/)
    })

    it('prefixing prevents a literal task_id collision with an existing (already-namespaced) task', () => {
        // Pass 1 already produced "p1-fix-auth". Pass 2's freshly generated spec
        // ALSO names a task literally "fix-auth" — pre-prefix these WOULD collide
        // if compared raw. Prove the prefix, not incidental non-overlap, is what
        // prevents it: both survive distinctly in the returned map.
        const pass1: Record<string, TaskState> = {
            'p1-fix-auth': {
                task_id: 'p1-fix-auth',
                status: 'done',
                depends_on: [],
                escalation_rung: 0,
                reviewers: [],
                merge_resyncs: 0,
            },
        }

        const merged = appendTasksFromSpec(pass1, request([task('fix-auth', [])], '99-followup'), 2)

        expect(Object.keys(merged).sort()).toEqual(['p1-fix-auth', 'p2-fix-auth'])
        expect(nonNull(merged['p1-fix-auth']).status).toBe('done')
        expect(nonNull(merged['p2-fix-auth']).status).toBe('pending')
    })
})
