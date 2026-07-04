/**
 * Unit tests for applyCircuitBreaker — the orchestrator-layer wiring of the pure breaker.
 *
 * Focus: the DERIVATION the gate owns (the pure predicate's thresholds are already
 * covered in quota/circuit-breaker.test.ts): the failure count includes ONLY
 * capability-budget failures, excluding blocked-environmental cascades and
 * spec-defect wedges.
 *
 * Uses makeOrchestratorDeps (a real StateManager).
 */
import {describe, expect, it} from 'vitest'

import {applyCircuitBreaker} from './circuit-breaker-gate.js'
import {makeOrchestratorDeps} from './orchestrator-fixtures.js'
import type {FailureClass} from '../types/index.js'

/** Seed `task_id` as a classified fail (mirrors the WS1 failed-task invariant). */
async function failTask(
    state: Awaited<ReturnType<typeof makeOrchestratorDeps>>['state'],
    runId: string,
    taskId: string,
    failureClass: FailureClass
): Promise<void> {
    await state.updateTask(runId, taskId, (t) => ({
        ...t,
        status: 'failed',
        failure_class: failureClass,
        failure_reason: `test seed (${failureClass})`,
    }))
}

const FOUR = [
    {task_id: 'T1', acceptance_criteria: ['only one']},
    {task_id: 'T2', acceptance_criteria: ['only one']},
    {task_id: 'T3', acceptance_criteria: ['only one']},
    {task_id: 'T4', acceptance_criteria: ['only one']},
]

describe('applyCircuitBreaker — capability-budget failures only', () => {
    it('trips at the cap of capability-budget failures', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({tasks: FOUR})
        try {
            await failTask(state, runId, 'T1', 'capability-budget')
            await failTask(state, runId, 'T2', 'capability-budget')
            await failTask(state, runId, 'T3', 'capability-budget')
            const v = await applyCircuitBreaker(deps, runId)
            expect(v?.tripped).toBe(true)
            if (v) {
                expect(v.reason).toMatch(/cumulative failures/)
            }
        } finally {
            await cleanup()
        }
    })

    it('does NOT count blocked-environmental cascades (dependency consequences)', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({tasks: FOUR})
        try {
            await failTask(state, runId, 'T1', 'blocked-environmental')
            await failTask(state, runId, 'T2', 'blocked-environmental')
            await failTask(state, runId, 'T3', 'blocked-environmental')
            await failTask(state, runId, 'T4', 'blocked-environmental')
            expect(await applyCircuitBreaker(deps, runId)).toBeNull()
        } finally {
            await cleanup()
        }
    })

    it('does NOT count spec-defect wedge failures', async () => {
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({tasks: FOUR})
        try {
            await failTask(state, runId, 'T1', 'spec-defect')
            await failTask(state, runId, 'T2', 'spec-defect')
            await failTask(state, runId, 'T3', 'spec-defect')
            expect(await applyCircuitBreaker(deps, runId)).toBeNull()
        } finally {
            await cleanup()
        }
    })

    it('one real failure cascading to two dependents does NOT trip (2 < cap of 3 genuine)', async () => {
        // The exact false-trip this derivation prevents: 1 capability-budget + cascades.
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({tasks: FOUR})
        try {
            await failTask(state, runId, 'T1', 'capability-budget') // the one real failure
            await failTask(state, runId, 'T2', 'blocked-environmental') // cascade
            await failTask(state, runId, 'T3', 'blocked-environmental') // cascade
            // Even a second genuine failure stays under the cap (2 < 3).
            await failTask(state, runId, 'T4', 'capability-budget')
            expect(await applyCircuitBreaker(deps, runId)).toBeNull()
        } finally {
            await cleanup()
        }
    })

    it('passes the real task count: a 30-task run tolerates 4 genuine failures, trips at 5', async () => {
        const thirty = Array.from({length: 30}, (_, i) => ({
            task_id: `T${i + 1}`,
            acceptance_criteria: ['only one'],
        }))
        const {deps, runId, state, cleanup} = await makeOrchestratorDeps({tasks: thirty})
        try {
            for (const id of ['T1', 'T2', 'T3', 'T4']) {
                await failTask(state, runId, id, 'capability-budget')
            }
            // Proportional threshold ceil(0.15×30)=5 > floor 3 — 4 genuine failures survive.
            expect(await applyCircuitBreaker(deps, runId)).toBeNull()
            await failTask(state, runId, 'T5', 'capability-budget')
            const v = await applyCircuitBreaker(deps, runId)
            expect(v?.tripped).toBe(true)
        } finally {
            await cleanup()
        }
    })

    it('a healthy run does not trip', async () => {
        const {deps, runId, cleanup} = await makeOrchestratorDeps()
        try {
            expect(await applyCircuitBreaker(deps, runId)).toBeNull()
        } finally {
            await cleanup()
        }
    })
})
