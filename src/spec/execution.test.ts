import {describe, expect, it} from 'vitest'
import {executionOrder, safeRepoPath} from './execution.js'
import type {SpecTask} from './schema.js'

const task = (task_id: string, depends_on: string[] = [], slice_id = task_id): SpecTask => ({
    task_id,
    depends_on,
    slice_id,
    title: task_id,
    description: 'Deliver tested behavior',
    files: ['src/shared.ts'],
    acceptance_criteria: ['Returns the requested value'],
    tests_to_write: ['Assert returned value'],
    risk_tier: 'low',
    risk_rationale: 'Local behavior',
})

describe('executable spec ordering', () => {
    it('orders shared-file work by transitive dependencies', () => {
        expect(executionOrder([task('c', ['b']), task('a'), task('b', ['a'])]).map((t) => t.task_id)).toEqual([
            'a',
            'b',
            'c',
        ])
    })
    it.each([
        [[task('a'), task('a')], 'duplicate task id'],
        [[task('a', ['missing'])], 'unknown dependency'],
        [[task('a', ['b']), task('b', ['a'])], 'dependency cycle'],
        [[task('a'), task('b')], 'requires a dependency'],
        [[task('a'), task('b', ['a', 'a'])], 'duplicate dependencies'],
        [[task('a', [], 'first'), task('b', ['a'], 'second'), task('c', ['b'], 'first')], 'interleaved'],
    ] as const)('rejects invalid execution graphs %#', (tasks, message) => {
        expect(() => executionOrder(tasks)).toThrow(message)
    })
    it.each(['../outside.ts', '/absolute.ts', 'src/*.ts', 'src/../a.ts', 'src\\a.ts', 'src/a\u0000.ts'])(
        'rejects unsafe path %s',
        (path) => {
            expect(safeRepoPath(path)).toBe(false)
            expect(() => executionOrder([{...task('a'), files: [path]}])).toThrow('safe repository-relative')
        }
    )
})
