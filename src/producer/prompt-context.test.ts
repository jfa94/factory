import {describe, it, expect} from 'vitest'
import {buildProducerContext, renderProducerPrompt} from './prompt-context.js'
import {fakeFinding} from './fakes.js'

describe('prompt-context — holdout integrity (D5/Δ Y)', () => {
    it('the assembled context contains ONLY the visible (holdout-stripped) criteria — there is no holdout field/path', () => {
        const ctx = buildProducerContext({
            taskId: 'T1',
            title: 't',
            description: 'd',
            visibleCriteria: ['visible-1', 'visible-2'],
            files: ['src/a.ts'],
            rung: 0,
        })
        expect(ctx.acceptanceCriteria).toEqual(['visible-1', 'visible-2'])
        // No holdout key surface: assert the structured context has no holdout-* key.
        const keys = Object.keys(ctx)
        expect(keys.some((k) => /holdout/i.test(k))).toBe(false)
    })
})

describe('prompt-context — rung-2 prior-failure injection is the changed variable (D25)', () => {
    it('rung 0/1 inject no prior failures (injectedPriorFailure=false)', () => {
        const ctx = buildProducerContext({
            taskId: 'T1',
            title: 't',
            description: 'd',
            visibleCriteria: ['c'],
            files: ['f'],
            rung: 1,
        })
        expect(ctx.injectedPriorFailure).toBe(false)
        expect(ctx.priorFailures).toHaveLength(0)
    })

    it('rung 2 with prior-failure notes → injectedPriorFailure=true (the rung-2 context change)', () => {
        const ctx = buildProducerContext({
            taskId: 'T1',
            title: 't',
            description: 'd',
            visibleCriteria: ['c'],
            files: ['f'],
            rung: 2,
            priorFailures: [{rung: 1, summary: 'merge gate blocked by security'}],
        })
        expect(ctx.injectedPriorFailure).toBe(true)
        expect(ctx.priorFailures[0]?.summary).toContain('security')
    })
})

describe('prompt-context — fix-forward instructions (D27)', () => {
    it('confirmed blockers become concrete fix instructions (PATCH, not nuke)', () => {
        const ctx = buildProducerContext({
            taskId: 'T1',
            title: 't',
            description: 'd',
            visibleCriteria: ['c'],
            files: ['f'],
            rung: 0,
            confirmedBlockers: [fakeFinding({file: 'src/x.ts', line: 42, description: 'fix the null deref'})],
        })
        expect(ctx.fixInstructions).toHaveLength(1)
        expect(ctx.fixInstructions[0]).toMatchObject({
            file: 'src/x.ts',
            line: 42,
            description: 'fix the null deref',
        })
    })

    it('an uncitable confirmed blocker still yields a fix instruction (file/line omitted)', () => {
        const f = fakeFinding()
        const ctx = buildProducerContext({
            taskId: 'T1',
            title: 't',
            description: 'd',
            visibleCriteria: ['c'],
            files: ['f'],
            rung: 0,
            confirmedBlockers: [{...f, file: undefined, line: undefined}],
        })
        expect(ctx.fixInstructions[0]?.file).toBeUndefined()
        expect(ctx.fixInstructions[0]?.line).toBeUndefined()
        expect(ctx.fixInstructions[0]?.description.length).toBeGreaterThan(0)
    })

    it('a blocker with a file but NO line carries the file and omits the line', () => {
        const f = fakeFinding()
        const ctx = buildProducerContext({
            taskId: 'T1',
            title: 't',
            description: 'd',
            visibleCriteria: ['c'],
            files: ['f'],
            rung: 0,
            confirmedBlockers: [{...f, file: 'src/y.ts', line: undefined}],
        })
        expect(ctx.fixInstructions[0]?.file).toBe('src/y.ts')
        expect(ctx.fixInstructions[0]?.line).toBeUndefined()
    })

    it('a lean gate-stderr-sourced blocker (no severity/blocking/quote — a persisted fix_findings record) still yields a fix instruction', () => {
        // D5: record.ts persists TaskState.fix_findings as the lean {reviewer, file?,
        // line?, description} shape — NOT a full judgment Finding. This proves that
        // shape satisfies confirmedBlockers without any conversion step.
        const ctx = buildProducerContext({
            taskId: 'T1',
            title: 't',
            description: 'd',
            visibleCriteria: ['c'],
            files: ['f'],
            rung: 0,
            confirmedBlockers: [
                {
                    reviewer: 'lint',
                    file: 'src/lib/x.ts',
                    line: 10,
                    description: 'eslint exit=1: no-unsafe-assignment',
                },
            ],
        })
        expect(ctx.fixInstructions).toHaveLength(1)
        expect(ctx.fixInstructions[0]).toMatchObject({
            reviewer: 'lint',
            file: 'src/lib/x.ts',
            line: 10,
            description: 'eslint exit=1: no-unsafe-assignment',
        })
    })
})

describe('renderProducerPrompt — 3b(i) inline spawn prompt', () => {
    it('renders title/description/criteria and the cd-sentence with the worktree path', () => {
        const ctx = buildProducerContext({
            taskId: 'T1',
            title: 'Add login',
            description: 'Implement the login form.',
            visibleCriteria: ['renders a form', 'submits credentials'],
            files: ['src/login.ts'],
            rung: 0,
        })
        const prompt = renderProducerPrompt(ctx, '/data/runs/run-1/worktrees/T1')

        expect(prompt).toContain('Add login')
        expect(prompt).toContain('Implement the login form.')
        expect(prompt).toContain('- renders a form')
        expect(prompt).toContain('- submits credentials')
        expect(prompt).toContain('- src/login.ts')
        expect(prompt).toContain(
            'Your working tree is /data/runs/run-1/worktrees/T1 (already checked out on the task branch). cd there; make ALL commits there.'
        )
    })

    it('renders fix instructions and prior-failure notes when present', () => {
        const ctx = buildProducerContext({
            taskId: 'T1',
            title: 't',
            description: 'd',
            visibleCriteria: ['c'],
            files: [],
            rung: 2,
            confirmedBlockers: [{reviewer: 'quality-reviewer', file: 'src/x.ts', line: 5, description: 'null deref'}],
            priorFailures: [{rung: 1, summary: 'merge gate blocked by security'}],
        })
        const prompt = renderProducerPrompt(ctx, '/wt')

        expect(prompt).toContain('Confirmed blockers to fix')
        expect(prompt).toContain('[quality-reviewer] (src/x.ts:5) null deref')
        expect(prompt).toContain("Prior failures — don't repeat these:")
        expect(prompt).toContain('rung 1: merge gate blocked by security')
    })

    it('renders design-system guidance when docs are present', () => {
        const ctx = buildProducerContext({
            taskId: 'T1',
            title: 't',
            description: 'd',
            visibleCriteria: ['c'],
            files: ['src/Button.tsx'],
            rung: 0,
            designSystemDocs: ['docs/design-system.md', 'docs/ui-guidelines.md'],
        })

        const prompt = renderProducerPrompt(ctx, '/wt')

        expect(ctx.designSystemDocs).toEqual(['docs/design-system.md', 'docs/ui-guidelines.md'])
        expect(prompt).toContain(
            'Design system: this repo documents a design system at docs/design-system.md, docs/ui-guidelines.md.'
        )
        expect(prompt).toContain('Read it BEFORE writing any UI code')
    })

    it('renders the tests-to-write section after acceptance criteria (Fix 2)', () => {
        const ctx = buildProducerContext({
            taskId: 'T1',
            title: 't',
            description: 'd',
            visibleCriteria: ['c1'],
            files: [],
            rung: 0,
            testsToWrite: ['POST /checkout returns 201', 'rejects an empty cart'],
        })
        const prompt = renderProducerPrompt(ctx, '/wt')

        expect(ctx.testsToWrite).toEqual(['POST /checkout returns 201', 'rejects an empty cart'])
        expect(prompt).toContain('Tests to write:')
        expect(prompt).toContain('- POST /checkout returns 201')
        expect(prompt).toContain('- rejects an empty cart')
        expect(prompt.indexOf('Acceptance criteria:')).toBeLessThan(prompt.indexOf('Tests to write:'))
    })

    it('omits the scoped-files/fix/prior-failure sections when empty', () => {
        const ctx = buildProducerContext({
            taskId: 'T1',
            title: 't',
            description: 'd',
            visibleCriteria: ['c'],
            files: [],
            rung: 0,
        })
        const prompt = renderProducerPrompt(ctx, '/wt')

        expect(prompt).not.toContain('Scoped files:')
        expect(prompt).not.toContain('Confirmed blockers to fix')
        expect(prompt).not.toContain('Prior failures')
        expect(prompt).not.toContain('Design system:')
        expect(prompt).not.toContain('Tests to write:')
    })
})
