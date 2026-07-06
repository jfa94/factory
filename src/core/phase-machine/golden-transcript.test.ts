/**
 * WS2 — THE acceptance harness. A canned 2-task run (one ships, one fails) driven
 * through the engine by FULLY-FAKE handlers, asserting a FIXED PhaseResult
 * SEQUENCE. This is the golden contract: if the engine's dispatch or a result
 * shape drifts, the recorded transcript diverges.
 *
 * It exercises every acceptance criterion in one place:
 *   - the full per-task walk preflight→tests→exec→verify→ship for each task,
 *   - a `spawn-agents` at tests / exec / verify,
 *   - a `task-terminal(done)` and a `task-terminal(failed, capability-budget)`,
 *   - a run-level `finalize-terminal(partial)` (NOT wait-retry) for the incomplete
 *     (one-failed) run,
 *   - finalize THROWS on a leftover non-terminal task (anti-spin).
 */
import {describe, expect, it} from 'vitest'
import {runPhase, nextPhaseFor, decideFinalize, type EnginePhase} from './engine.js'
import {advance, spawn, taskDone, taskFailed, type PhaseResult} from './result.js'
import type {PhaseContext, PhaseHandlers} from './handlers.js'
import type {SpawnRequest} from './spawn.js'
import {parseRunState, type RunState} from '../state/index.js'

// --- canned spec: two tasks ---------------------------------------------------

const mkManifest = (
    resume_phase: SpawnRequest['resume_phase'],
    role: SpawnRequest['agents'][number]['role']
): SpawnRequest => ({
    resume_phase,
    agents: [
        {
            role,
            isolation: 'worktree',
            model: 'sonnet',
            max_turns: 60,
            prompt_ref: `prompts/${role}.md`,
        },
    ],
})

/**
 * Fake handlers that drive a task to a desired outcome via a fixed script. The
 * "happy" task spawns at tests/exec/verify then ships to done. The "fail" task
 * spawns at tests then the exec phase classifies a capability-budget failure.
 */
function scriptedHandlers(outcome: 'ship' | 'fail'): PhaseHandlers {
    const finalize: PhaseHandlers['finalize'] = (ctx) => Promise.resolve(decideFinalize(ctx.run))
    if (outcome === 'ship') {
        return {
            preflight: () => Promise.resolve(advance('tests')),
            tests: () => Promise.resolve(spawn(mkManifest('exec', 'test-writer'))),
            exec: () => Promise.resolve(spawn(mkManifest('verify', 'implementer'))),
            verify: () => Promise.resolve(spawn(mkManifest('ship', 'implementation-reviewer'))),
            ship: () => Promise.resolve(taskDone()),
            finalize,
        }
    }
    return {
        preflight: () => Promise.resolve(advance('tests')),
        tests: () => Promise.resolve(spawn(mkManifest('exec', 'test-writer'))),
        exec: () => Promise.resolve(taskFailed('capability-budget', 'producer ladder exhausted')),
        verify: () => Promise.resolve(taskDone()),
        ship: () => Promise.resolve(taskDone()),
        finalize,
    }
}

/**
 * Drive ONE task from preflight to a terminal result, recording each
 * PhaseResult. Uses the engine's own nextPhaseFor to compute the resume phase —
 * so the transcript also asserts the shared transition logic.
 */
async function driveTask(handlers: PhaseHandlers, ctx: PhaseContext): Promise<PhaseResult[]> {
    const transcript: PhaseResult[] = []
    let phase: EnginePhase | null = 'preflight'
    while (phase !== null) {
        const r: PhaseResult = await runPhase(phase, ctx, handlers)
        transcript.push(r)
        if (r.kind === 'task-terminal') {
            break
        }
        const next = nextPhaseFor(r) // advance.to or request.resume_phase
        phase = next
    }
    return transcript
}

const baseRun = (tasks: Record<string, unknown>): RunState =>
    parseRunState({
        run_id: 'run-20260604-120000',
        staging_branch: 'staging-run-20260604-120000',
        spec: {repo: 'o/r', spec_id: '1-golden', issue_number: 1},
        started_at: '2026-06-04T12:00:00.000Z',
        updated_at: '2026-06-04T12:00:00.000Z',
        tasks,
    })

describe('golden transcript — fixed PhaseResult sequence', () => {
    it('the happy task walks preflight→tests→exec→verify→ship to task-terminal(done)', async () => {
        const ctx: PhaseContext = {
            run: baseRun({a: {task_id: 'a', status: 'pending', risk_tier: 'low'}}),
        }
        const transcript = await driveTask(scriptedHandlers('ship'), ctx)

        expect(transcript).toEqual([
            advance('tests'),
            spawn(mkManifest('exec', 'test-writer')),
            spawn(mkManifest('verify', 'implementer')),
            spawn(mkManifest('ship', 'implementation-reviewer')),
            taskDone(),
        ])
    })

    it('the fail task reaches task-terminal(failed, capability-budget)', async () => {
        const ctx: PhaseContext = {
            run: baseRun({b: {task_id: 'b', status: 'pending', risk_tier: 'low'}}),
        }
        const transcript = await driveTask(scriptedHandlers('fail'), ctx)

        expect(transcript).toEqual([
            advance('tests'),
            spawn(mkManifest('exec', 'test-writer')),
            taskFailed('capability-budget', 'producer ladder exhausted'),
        ])
    })

    it('the run-level finalize over {done, failed} is finalize-terminal(failed), never wait-retry (Decision 34)', async () => {
        // Both tasks now terminal: a shipped, b failed.
        // Decision 34: develop receives only complete PRDs — mixed done+failed is 'failed'.
        const ctx: PhaseContext = {
            run: baseRun({
                a: {task_id: 'a', status: 'done', risk_tier: 'low'},
                b: {
                    task_id: 'b',
                    status: 'failed',
                    risk_tier: 'low',
                    failure_class: 'capability-budget',
                    failure_reason: 'producer ladder exhausted',
                },
            }),
        }
        const r = await runPhase('finalize', ctx, scriptedHandlers('ship'))
        expect(r).toEqual({kind: 'finalize-terminal', run_status: 'failed'})
        expect(r.kind).not.toBe('wait-retry')
    })

    it('finalize over an incomplete (non-terminal) run THROWS, never spins', async () => {
        const ctx: PhaseContext = {
            run: baseRun({
                a: {task_id: 'a', status: 'done', risk_tier: 'low'},
                b: {task_id: 'b', status: 'executing', risk_tier: 'low'},
            }),
        }
        await expect(runPhase('finalize', ctx, scriptedHandlers('ship'))).rejects.toThrow(/non-terminal task/)
    })
})
