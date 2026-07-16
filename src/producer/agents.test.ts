import {describe, it, expect} from 'vitest'
import {parseProducerStatus} from './agents.js'

describe('parseProducerStatus — closed outcome from the terminal STATUS line', () => {
    it('STATUS: DONE → done', () => {
        expect(parseProducerStatus('STATUS: DONE')).toEqual({status: 'done'})
    })

    it('STATUS: BLOCKED — escalate → blocked-escalate (spec-defect signal, Δ D)', () => {
        const o = parseProducerStatus('STATUS: BLOCKED — escalate: contradictory criteria')
        expect(o.status).toBe('blocked-escalate')
        if (o.status === 'blocked-escalate') {
            expect(o.reason).toContain('escalate')
        }
    })

    it('STATUS: BLOCKED — escalate: test requires revision → test-defective (recoverable, Δ D)', () => {
        const o = parseProducerStatus('STATUS: BLOCKED — escalate: test requires revision — pins user_id = auth.uid()')
        expect(o.status).toBe('test-defective')
        if (o.status === 'test-defective') {
            expect(o.reason).toContain('test requires revision')
        }
    })

    it('test-defective takes precedence over plain blocked-escalate (more specific wins)', () => {
        // Both keywords present; the contiguous 'test requires revision' phrase routes to recovery.
        expect(parseProducerStatus('STATUS: BLOCKED — escalate: TEST REQUIRES REVISION').status).toBe('test-defective')
    })

    it('a BLOCKED — escalate line WITHOUT the contiguous phrase stays blocked-escalate (spec-defect)', () => {
        // Non-contiguous mention ("the criterion for the test requires revision") must NOT
        // be mistaken for a defective-test signal — it is a genuine spec contradiction.
        expect(parseProducerStatus('STATUS: BLOCKED — escalate: the criterion the test verifies is wrong').status).toBe(
            'blocked-escalate'
        )
    })

    it('STATUS: NEEDS_CONTEXT → needs-context (retry signal, not a fail)', () => {
        expect(parseProducerStatus('STATUS: NEEDS_CONTEXT').status).toBe('needs-context')
    })

    // Decision 70 — the base already contains this task's work; the engine verifies.
    it('STATUS: ALREADY_SATISFIED with cited SHAs → already-satisfied (Decision 70)', () => {
        const o = parseProducerStatus(
            'STATUS: ALREADY_SATISFIED — abc1234, 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e: PR #12 landed the auth flow'
        )
        expect(o).toEqual({
            status: 'already-satisfied',
            shas: ['abc1234', '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e'],
            reason: 'STATUS: ALREADY_SATISFIED — abc1234, 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e: PR #12 landed the auth flow',
        })
    })

    it("the spaced 'ALREADY SATISFIED' variant also parses (Decision 70)", () => {
        const o = parseProducerStatus('STATUS: ALREADY SATISFIED — see deadbeef')
        expect(o.status).toBe('already-satisfied')
        if (o.status === 'already-satisfied') {
            expect(o.shas).toEqual(['deadbeef'])
        }
    })

    it('ALREADY_SATISFIED with NO citable SHA still parses (the verifier rejects downstream, not the parser)', () => {
        const o = parseProducerStatus('STATUS: ALREADY_SATISFIED — trust me')
        expect(o).toEqual({status: 'already-satisfied', shas: [], reason: 'STATUS: ALREADY_SATISFIED — trust me'})
    })

    it('ALREADY_SATISFIED ignores non-SHA hex noise shorter than 7 chars', () => {
        const o = parseProducerStatus('STATUS: ALREADY_SATISFIED — abc123 is too short but abcdef0 counts')
        expect(o.status).toBe('already-satisfied')
        if (o.status === 'already-satisfied') {
            expect(o.shas).toEqual(['abcdef0'])
        }
    })

    it("an unparseable / empty status → error (never silently 'done')", () => {
        expect(parseProducerStatus('garbage line').status).toBe('error')
        expect(parseProducerStatus('').status).toBe('error')
    })

    it('BLOCKED+escalate wins over a co-occurring DONE keyword (escalate signal precedence)', () => {
        expect(parseProducerStatus('DONE? no — BLOCKED, please escalate').status).toBe('blocked-escalate')
    })

    // SF-D: leading-keyword anchor — substring match silently promoted "NOT DONE" and
    // "ABANDONED" (contains "DONE") to done. The fix anchors to the status keyword.
    it("SF-D: 'NOT DONE' is NOT done — substring match regression guard", () => {
        expect(parseProducerStatus('STATUS: NOT DONE').status).toBe('error')
        expect(parseProducerStatus('NOT DONE').status).toBe('error')
    })

    it("SF-D: 'ABANDONED' is NOT done (contains 'ABAN-DONE-D' substring)", () => {
        expect(parseProducerStatus('STATUS: ABANDONED').status).toBe('error')
        expect(parseProducerStatus('ABANDONED').status).toBe('error')
    })

    it('SF-D: DONE with trailing detail is still done (tolerates cosmetic suffix)', () => {
        expect(parseProducerStatus('STATUS: DONE — all tests green').status).toBe('done')
        expect(parseProducerStatus('DONE. shipped.').status).toBe('done')
    })

    // S12 smoke defect: the scribe's documented DONE_WITH_CONCERNS status
    // (agents/scribe.md) is a success-with-note, but the `_` broke the old `DONE\b`
    // anchor → the docs stage suspended a run the scribe had actually finished.
    it("DONE_WITH_CONCERNS is done — the scribe's documented success-with-note variant", () => {
        expect(parseProducerStatus('STATUS: DONE_WITH_CONCERNS — a concern').status).toBe('done')
        expect(parseProducerStatus('DONE_WITH_CONCERNS').status).toBe('done')
    })

    it('DONE followed by an undocumented _SUFFIX stays error (narrow acceptance)', () => {
        expect(parseProducerStatus('STATUS: DONE_SOMETHING_ELSE').status).toBe('error')
    })
})
