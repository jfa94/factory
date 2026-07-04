import {describe, it, expect} from 'vitest'
import {parseSpecTasks, parseSpecManifest, SpecTaskSchema} from './schema.js'
import {at} from '../shared/index.js'

const validTask = {
    task_id: 'task_1',
    title: 'Add checkout endpoint',
    description: 'Implement POST /checkout that creates an order',
    files: ['src/checkout.ts'],
    acceptance_criteria: ['POST /checkout returns 201 with an order id'],
    tests_to_write: ['POST /checkout returns 201 and an order id for a valid cart'],
    depends_on: [],
    risk_tier: 'medium',
    risk_rationale: 'touches payment path, moderate stakes',
}

describe('D25 single producer dial — SpecTaskSchema', () => {
    it('D25: accepts a task carrying a risk_tier in {low,medium,high} + non-empty rationale', () => {
        const tasks = parseSpecTasks([validTask])
        expect(at(tasks, 0).risk_tier).toBe('medium')
        expect(at(tasks, 0).risk_rationale.length).toBeGreaterThan(0)
    })

    it('D25: REJECTS a task missing risk_tier', () => {
        const {risk_tier: _omit, ...noTier} = validTask
        void _omit
        expect(() => parseSpecTasks([noTier])).toThrow()
    })

    it('D25: REJECTS a task missing risk_rationale', () => {
        const {risk_rationale: _omit, ...noRationale} = validTask
        void _omit
        expect(() => parseSpecTasks([noRationale])).toThrow()
    })

    it('D25: REJECTS legacy routine/feature/security risk values (deleted classifier)', () => {
        for (const legacy of ['routine', 'feature', 'security']) {
            expect(() => parseSpecTasks([{...validTask, risk_tier: legacy}])).toThrow()
        }
    })

    it('D25: REJECTS a resurrected review-depth / review_rounds second axis (strict schema)', () => {
        expect(() => parseSpecTasks([{...validTask, review_depth: 'deep'}])).toThrow()
        expect(() => parseSpecTasks([{...validTask, review_rounds: 3}])).toThrow()
    })
})

describe('Δ granularity — files 1..3 invariant', () => {
    it('accepts 1..3 files', () => {
        expect(SpecTaskSchema.parse({...validTask, files: ['a.ts', 'b.ts', 'c.ts']}).files).toHaveLength(3)
    })
    it('rejects 0 files', () => {
        expect(() => SpecTaskSchema.parse({...validTask, files: []})).toThrow()
    })
    it('rejects >3 files', () => {
        expect(() => SpecTaskSchema.parse({...validTask, files: ['a', 'b', 'c', 'd']})).toThrow()
    })
    it('requires ≥1 acceptance criterion and ≥1 test', () => {
        expect(() => SpecTaskSchema.parse({...validTask, acceptance_criteria: []})).toThrow()
        expect(() => SpecTaskSchema.parse({...validTask, tests_to_write: []})).toThrow()
    })
})

describe('SpecManifest', () => {
    it('parses a valid request and defaults depends_on', () => {
        const m = parseSpecManifest({
            spec_id: '42-checkout',
            issue_number: 42,
            slug: 'checkout',
            repo: 'owner/name',
            generated_at: '2026-06-04T00:00:00.000Z',
            tasks: [validTask],
        })
        expect(at(m.tasks, 0).depends_on).toEqual([])
    })

    it('rejects a request with a non-positive issue number', () => {
        expect(() =>
            parseSpecManifest({
                spec_id: '0-x',
                issue_number: 0,
                slug: 'x',
                repo: 'owner/name',
                generated_at: '2026-06-04T00:00:00.000Z',
                tasks: [validTask],
            })
        ).toThrow()
    })

    it('rejects an empty tasks array (≥1 task required)', () => {
        expect(() =>
            parseSpecManifest({
                spec_id: '1-x',
                issue_number: 1,
                slug: 'x',
                repo: 'owner/name',
                generated_at: '2026-06-04T00:00:00.000Z',
                tasks: [],
            })
        ).toThrow()
    })
})
