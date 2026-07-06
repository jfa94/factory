import {describe, expect, it, vi} from 'vitest'
import {runPhase, nextPhaseFor, decideFinalize} from './engine.js'
import {advance, spawn, gracefulStop, waitRetry, taskDone, finalizeTerminal, type PhaseResult} from './result.js'
import type {PhaseContext, PhaseHandlers} from './handlers.js'
import {parseRunState, type RunState} from '../state/index.js'

const ctx: PhaseContext = {
    run: parseRunState({
        run_id: 'run-20260604-000000',
        staging_branch: 'staging-run-20260604-000000',
        spec: {repo: 'o/r', spec_id: '1-x', issue_number: 1},
        started_at: '2026-06-04T00:00:00.000Z',
        updated_at: '2026-06-04T00:00:00.000Z',
        tasks: {},
    }),
}

/**
 * A handler set where every method records its call and returns a canned result.
 *
 * Return type is inferred (via `satisfies`, not an explicit `: PhaseHandlers` annotation)
 * so each field stays a plain property (a `vi.fn()` value) rather than adopting
 * `PhaseHandlers`' method-shorthand signatures — that keeps `expect(h.foo)` a property
 * read, not an unbound-method reference.
 */
function fakeHandlers(overrides: Partial<PhaseHandlers> = {}) {
    return {
        preflight: vi.fn(() => Promise.resolve(advance('tests'))),
        tests: vi.fn(() => Promise.resolve(advance('exec'))),
        exec: vi.fn(() => Promise.resolve(advance('verify'))),
        verify: vi.fn(() => Promise.resolve(advance('ship'))),
        ship: vi.fn(() => Promise.resolve(taskDone())),
        finalize: vi.fn(() => Promise.resolve(finalizeTerminal('completed'))),
        ...overrides,
    } satisfies PhaseHandlers
}

describe('runPhase dispatch', () => {
    it('calls the matching handler for each per-task phase', async () => {
        const h = fakeHandlers()
        await runPhase('preflight', ctx, h)
        await runPhase('tests', ctx, h)
        await runPhase('exec', ctx, h)
        await runPhase('verify', ctx, h)
        await runPhase('ship', ctx, h)
        expect(h.preflight).toHaveBeenCalledTimes(1)
        expect(h.tests).toHaveBeenCalledTimes(1)
        expect(h.exec).toHaveBeenCalledTimes(1)
        expect(h.verify).toHaveBeenCalledTimes(1)
        expect(h.ship).toHaveBeenCalledTimes(1)
        expect(h.finalize).not.toHaveBeenCalled()
    })

    it('routes the run-level finalize phase to the finalize handler', async () => {
        const h = fakeHandlers()
        const r = await runPhase('finalize', ctx, h)
        expect(h.finalize).toHaveBeenCalledTimes(1)
        expect(r).toEqual(finalizeTerminal('completed'))
    })

    it('throws on an unknown phase value', async () => {
        const h = fakeHandlers()
        await expect(runPhase('bogus' as never, ctx, h)).rejects.toThrow(/unknown phase/)
    })
})

describe('invariant #1 — unknown PhaseResult.kind THROWS, never advances', () => {
    it('a handler returning an unhandled kind makes the engine throw', async () => {
        const h = fakeHandlers({
            tests: () => Promise.resolve({kind: 'bogus'} as unknown as PhaseResult),
        })
        await expect(runPhase('tests', ctx, h)).rejects.toThrow(/unhandled value/)
    })
})

describe('invariant #2 — bounded wait-retry', () => {
    it('attempt within bound is returned', async () => {
        const h = fakeHandlers({ship: () => Promise.resolve(waitRetry('ship', 'ci', 2, 3))})
        const r = await runPhase('ship', ctx, h)
        expect(r.kind).toBe('wait-retry')
    })

    it('attempt === max_attempts is the last legal retry (boundary, not a throw)', async () => {
        const h = fakeHandlers({ship: () => Promise.resolve(waitRetry('ship', 'ci', 3, 3))})
        const r = await runPhase('ship', ctx, h)
        expect(r).toEqual(waitRetry('ship', 'ci', 3, 3))
    })

    it('attempt > max_attempts THROWS (never spins)', async () => {
        const h = fakeHandlers({ship: () => Promise.resolve(waitRetry('ship', 'ci', 4, 3))})
        await expect(runPhase('ship', ctx, h)).rejects.toThrow(/exceeded max_attempts/)
    })

    it('a wait-retry from finalize is rejected (finalize must never spin)', async () => {
        const h = fakeHandlers({finalize: () => Promise.resolve(waitRetry('ship', 'x', 1, 3))})
        await expect(runPhase('finalize', ctx, h)).rejects.toThrow(/finalize is terminal/)
    })
})

describe('graceful-stop is accepted from a per-task phase (quota breach, never a fail)', () => {
    it('a per-task phase returning graceful-stop is surfaced unchanged', async () => {
        const h = fakeHandlers({exec: () => Promise.resolve(gracefulStop('5h', '5h window breached'))})
        const r = await runPhase('exec', ctx, h)
        expect(r).toEqual(gracefulStop('5h', '5h window breached'))
        expect(nextPhaseFor(r)).toBeNull()
    })

    it('graceful-stop from finalize is rejected (finalize returns only finalize-terminal)', async () => {
        const h = fakeHandlers({finalize: () => Promise.resolve(gracefulStop('7d', '7d window breached'))})
        await expect(runPhase('finalize', ctx, h)).rejects.toThrow(/finalize is terminal/)
    })
})

describe('invariant #3 — finalize is terminal-by-construction at the seam', () => {
    it('finalize returning advance is rejected (only finalize-terminal is legal)', async () => {
        const h = fakeHandlers({finalize: () => Promise.resolve(advance('ship'))})
        await expect(runPhase('finalize', ctx, h)).rejects.toThrow(/finalize is terminal/)
    })

    it('finalize returning spawn-agents is rejected', async () => {
        const h = fakeHandlers({
            finalize: () =>
                Promise.resolve(
                    spawn({
                        resume_phase: 'exec',
                        agents: [
                            {
                                role: 'implementer',
                                agent_type: 'implementer',
                                isolation: 'worktree',
                                model: 's',
                                max_turns: 1,
                                prompt_ref: 'p',
                            },
                        ],
                    })
                ),
        })
        await expect(runPhase('finalize', ctx, h)).rejects.toThrow(/finalize is terminal/)
    })

    it('finalize returning task-terminal is rejected', async () => {
        const h = fakeHandlers({finalize: () => Promise.resolve(taskDone())})
        await expect(runPhase('finalize', ctx, h)).rejects.toThrow(/finalize is terminal/)
    })

    it('finalize returning finalize-terminal is accepted', async () => {
        const h = fakeHandlers({finalize: () => Promise.resolve(finalizeTerminal('failed'))})
        const r = await runPhase('finalize', ctx, h)
        expect(r).toEqual(finalizeTerminal('failed'))
    })

    it('a per-task phase returning finalize-terminal is rejected (reserved for finalize)', async () => {
        const h = fakeHandlers({ship: () => Promise.resolve(finalizeTerminal('completed'))})
        await expect(runPhase('ship', ctx, h)).rejects.toThrow(/reserved for the run-level finalize/)
    })
})

describe('nextPhaseFor', () => {
    it('advance resumes at .to; spawn-agents resumes at request.resume_phase', () => {
        expect(nextPhaseFor(advance('verify'))).toBe('verify')
        expect(
            nextPhaseFor(
                spawn({
                    resume_phase: 'exec',
                    agents: [
                        {
                            role: 'implementer',
                            agent_type: 'implementer',
                            isolation: 'worktree',
                            model: 's',
                            max_turns: 1,
                            prompt_ref: 'p',
                        },
                    ],
                })
            )
        ).toBe('exec')
    })

    it('terminals / wait-retry / graceful-stop imply no resume phase', () => {
        expect(nextPhaseFor(taskDone())).toBeNull()
        expect(nextPhaseFor(finalizeTerminal('failed'))).toBeNull()
        expect(nextPhaseFor(waitRetry('ship', 'x', 1, 3))).toBeNull()
    })
})

describe('decideFinalize is pure + terminal-by-construction', () => {
    const mkRun = (tasks: Record<string, unknown>): RunState =>
        parseRunState({
            run_id: 'run-20260604-000000',
            staging_branch: 'staging-run-20260604-000000',
            spec: {repo: 'o/r', spec_id: '1-x', issue_number: 1},
            started_at: '2026-06-04T00:00:00.000Z',
            updated_at: '2026-06-04T00:00:00.000Z',
            tasks,
        })

    it('all done → completed', () => {
        const run = mkRun({
            a: {task_id: 'a', status: 'done', risk_tier: 'low'},
            b: {task_id: 'b', status: 'done', risk_tier: 'low'},
        })
        expect(decideFinalize(run)).toEqual(finalizeTerminal('completed'))
    })

    it('some done + some failed → failed (develop gets nothing, Decision 34)', () => {
        const run = mkRun({
            a: {task_id: 'a', status: 'done', risk_tier: 'low'},
            b: {
                task_id: 'b',
                status: 'failed',
                risk_tier: 'low',
                failure_class: 'spec-defect',
                failure_reason: 'untestable criterion',
            },
        })
        expect(decideFinalize(run)).toEqual(finalizeTerminal('failed'))
    })

    it('zero done → failed (no partial delivery)', () => {
        const run = mkRun({
            a: {
                task_id: 'a',
                status: 'failed',
                risk_tier: 'low',
                failure_class: 'capability-budget',
                failure_reason: 'producer ladder exhausted',
            },
        })
        expect(decideFinalize(run)).toEqual(finalizeTerminal('failed'))
    })

    it('0 done → failed', () => {
        const run = mkRun({
            a: {
                task_id: 'a',
                status: 'failed',
                risk_tier: 'low',
                failure_class: 'capability-budget',
                failure_reason: 'producer ladder exhausted',
            },
        })
        expect(decideFinalize(run)).toEqual(finalizeTerminal('failed'))
    })

    it('empty task set → failed (nothing shippable)', () => {
        expect(decideFinalize(mkRun({}))).toEqual(finalizeTerminal('failed'))
    })

    it('a non-terminal task THROWS, never wait-retry (anti-spin)', () => {
        const run = mkRun({
            a: {task_id: 'a', status: 'done', risk_tier: 'low'},
            b: {task_id: 'b', status: 'reviewing', phase: 'verify', risk_tier: 'low'},
        })
        expect(() => decideFinalize(run)).toThrow(/non-terminal task/)
    })
})
