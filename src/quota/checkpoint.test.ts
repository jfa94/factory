import {describe, it, expect} from 'vitest'
import {parseRunState, type RunState} from '../types/index.js'
import {buildCheckpoint, clearCheckpoint} from './checkpoint.js'

/** A minimal running RunState we can merge a checkpoint patch into. */
function baseRun(): RunState {
    return parseRunState({
        schema_version: 2,
        run_id: 'run-20260604-000000',
        status: 'running',
        execution_mode: 'balanced',
        spec: {repo: 'owner/name', spec_id: '12-thing', issue_number: 12},
        tasks: {},
        started_at: '2026-06-04T00:00:00Z',
        updated_at: '2026-06-04T00:00:00Z',
        ended_at: null,
    })
}

describe('Δ E checkpoint invariant — buildCheckpoint pairs status with a valid quota checkpoint', () => {
    it("pause-5h → {status: paused, quota:{binding_window:'5h', resets_at_epoch}}", () => {
        const patch = buildCheckpoint({kind: 'pause-5h', resetsAtEpoch: 5000, reason: 'x'})
        expect(patch).toEqual({
            status: 'paused',
            quota: {binding_window: '5h', resets_at_epoch: 5000},
        })
    })

    it("suspend-7d → {status: suspended, quota:{binding_window:'7d', resets_at_epoch}}", () => {
        const patch = buildCheckpoint({kind: 'suspend-7d', resetsAtEpoch: 9000, reason: 'y'})
        expect(patch).toEqual({
            status: 'suspended',
            quota: {binding_window: '7d', resets_at_epoch: 9000},
        })
    })

    it('a pause patch merged into a run parses cleanly (quota present IFF paused)', () => {
        const patch = buildCheckpoint({kind: 'pause-5h', resetsAtEpoch: 5000, reason: 'x'})
        const merged = parseRunState({...baseRun(), ...patch})
        expect(merged.status).toBe('paused')
        expect(merged.quota).toEqual({binding_window: '5h', resets_at_epoch: 5000})
    })

    it('a suspend patch merged into a run parses cleanly (quota present IFF suspended)', () => {
        const patch = buildCheckpoint({kind: 'suspend-7d', resetsAtEpoch: 9000, reason: 'y'})
        const merged = parseRunState({...baseRun(), ...patch})
        expect(merged.status).toBe('suspended')
        expect(merged.quota?.binding_window).toBe('7d')
    })
})

describe('Δ F checkpoint invariant — clearCheckpoint returns to running with no quota', () => {
    it("clearCheckpoint() → {status:'running', quota: undefined}", () => {
        expect(clearCheckpoint()).toEqual({status: 'running', quota: undefined})
    })

    it('clearing a suspended run parses cleanly to running with quota dropped', () => {
        const suspended = parseRunState({
            ...baseRun(),
            status: 'suspended',
            quota: {binding_window: '7d', resets_at_epoch: 9000},
        })
        expect(suspended.status).toBe('suspended')

        const cleared = parseRunState({...suspended, ...clearCheckpoint()})
        expect(cleared.status).toBe('running')
        expect(cleared.quota).toBeUndefined()
    })

    it('the invariant is real: a quota checkpoint on a running run is REJECTED', () => {
        expect(() => parseRunState({...baseRun(), status: 'running', quota: {binding_window: '5h'}})).toThrow()
    })
})
