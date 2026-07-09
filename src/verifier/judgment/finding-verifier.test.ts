import {describe, it, expect, vi} from 'vitest'
import {parseFinding, isCitable} from './finding.js'
import {
    confirmBlocker,
    type ClaimOnlyFinding,
    type FindingVerifierRunner,
    type VerifierVerdict,
} from './finding-verifier.js'
import {nonNull} from '../../shared/index.js'

const parsed = parseFinding({
    reviewer: 'quality-reviewer',
    severity: 'critical',
    blocking: true,
    file: 'src/app.ts',
    line: 3,
    quote: 'const value = process(input)',
    claim: 'unsanitised input reaches process()',
    description: 'unsanitised input',
})
if (!isCitable(parsed)) {
    throw new Error('fixture must be citable')
}
const finding = parsed

function runner(fn: (f: ClaimOnlyFinding) => Promise<VerifierVerdict>, identity = 'codex'): FindingVerifierRunner {
    return {identity, confirm: fn}
}

describe('WS7 verify-then-fix finding-verifier (D27)', () => {
    it('D27: a finding that survives confirmation is CONFIRMED (reaches the producer)', async () => {
        const out = await confirmBlocker(
            finding,
            runner(() => Promise.resolve({holds: true, note: 'matched at line 3'})),
            'quality-reviewer'
        )
        expect(out.status).toBe('confirmed')
        if (out.status === 'confirmed') {
            expect(out.evidence.note).toMatch(/line 3/)
        }
    })

    it('D27: a refuted finding is NOT forwarded', async () => {
        const out = await confirmBlocker(
            finding,
            runner(() => Promise.resolve({holds: false, note: 'code already sanitises'})),
            'quality-reviewer'
        )
        expect(out.status).toBe('refuted')
    })

    it('D27 (bounded): the verifier runs EXACTLY ONCE per finding (no debate loop)', async () => {
        const spy = vi.fn(() => Promise.resolve({holds: true, note: 'ok'}))
        await confirmBlocker(finding, runner(spy), 'quality-reviewer')
        expect(spy).toHaveBeenCalledTimes(1)
    })

    it('D27 (independence): the verifier identity must differ from the finder', async () => {
        await expect(
            confirmBlocker(
                finding,
                runner(() => Promise.resolve({holds: true, note: 'ok'}), 'quality-reviewer'),
                'quality-reviewer'
            )
        ).rejects.toThrow(/INDEPENDENT/i)
    })

    it('D27 (loud error): a verifier error does NOT auto-confirm — it is unresolved', async () => {
        const out = await confirmBlocker(
            finding,
            runner(() => {
                throw new Error('agent crashed')
            }),
            'quality-reviewer'
        )
        expect(out.status).toBe('error')
        if (out.status === 'error') {
            expect(out.reason).toMatch(/errored/i)
        }
    })

    it('D27: a verifier error is never silently a refute either (distinct unresolved state)', async () => {
        const out = await confirmBlocker(
            finding,
            runner(() => {
                throw new Error('boom')
            }),
            'quality-reviewer'
        )
        expect(out.status).not.toBe('confirmed')
        expect(out.status).not.toBe('refuted')
    })
})

// S5/B2 — ADMISSIBILITY (anti-anchoring): a field reaches the verifier iff the verifier
// can CHECK it against the code. The `claim` is the proposition under test;
// `file`/`line`/`quote` say where to look. What the reviewer BELIEVED — its reasoning
// (`description`), its confidence (`severity`), its identity (`reviewer`) — is checkable
// against nothing, and is excluded both at the type level (`?: never`) and at runtime
// (exactly four keys reach the runner).
describe('claim-only projection (S5/B2)', () => {
    it('the runner receives EXACTLY {claim,file,line,quote}', async () => {
        let received: ClaimOnlyFinding | undefined
        await confirmBlocker(
            finding,
            runner((f) => {
                received = f
                return Promise.resolve({holds: true, note: 'ok'})
            }),
            'quality-reviewer'
        )
        expect(received).toBeDefined()
        expect(Object.keys(nonNull(received)).sort()).toEqual(['claim', 'file', 'line', 'quote'])
        expect(nonNull(received).claim).toBe('unsanitised input reaches process()')
    })

    // The finder's belief-state, field by field. Each would lead the verifier toward the
    // finder's prior, and none can be confirmed or refuted by reading the cited file.
    it.each(['description', 'severity', 'reviewer'])('never projects the inadmissible field `%s`', async (field) => {
        let received: ClaimOnlyFinding | undefined
        await confirmBlocker(
            finding,
            runner((f) => {
                received = f
                return Promise.resolve({holds: true, note: 'ok'})
            }),
            'quality-reviewer'
        )
        expect(received).not.toHaveProperty(field)
    })

    it('projects the CITED line (replay-verdict key, S5/A2) when the finding was grep-relocated', async () => {
        let received: ClaimOnlyFinding | undefined
        await confirmBlocker(
            finding, // finding.line === 3 (relocated)
            runner((f) => {
                received = f
                return Promise.resolve({holds: true, note: 'ok'})
            }),
            'quality-reviewer',
            9 // the reviewer's original cited line
        )
        expect(nonNull(received).line).toBe(9)
    })

    it('type-level leak guard: a full Finding is not assignable to ClaimOnlyFinding', () => {
        // @ts-expect-error — `description`/`severity`/`reviewer` are `?: never`, so any
        // object carrying the reviewer's belief-state fails to compile. This is why
        // confirmBlocker field-picks explicitly instead of spreading.
        const leak: ClaimOnlyFinding = {...finding}
        expect(leak).toBeDefined() // the assertion is the compile error above
    })
})
