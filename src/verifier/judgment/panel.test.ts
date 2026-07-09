import {describe, it, expect} from 'vitest'
import {RiskTierEnum, parseSpawnRequest, type RiskTier} from '../../types/index.js'
import {DB_DESIGN_ROLE, PANEL_ROLES, buildPanelManifest, panelRolesFor} from './panel.js'
import {at} from '../../shared/index.js'

const ALL_TIERS: readonly RiskTier[] = RiskTierEnum.options

/** The fixed per-role reviewer model (Δ T reversal) — mirrors panel.ts's own map. */
const OPUS_ROLES = new Set(['quality-reviewer', 'systemic-failure-reviewer', 'database-design-reviewer'])
function expectedModelFor(role: string): string {
    return OPUS_ROLES.has(role) ? 'opus' : 'sonnet'
}

describe('WS7 risk-invariant panel (D26 / Δ T)', () => {
    it('D43: panel is EXACTLY the 4 fixed consolidated roles', () => {
        expect([...PANEL_ROLES].sort()).toEqual(
            ['implementation-reviewer', 'quality-reviewer', 'silent-failure-hunter', 'systemic-failure-reviewer'].sort()
        )
        expect(PANEL_ROLES.length).toBe(4)
    })

    it('D26 / Δ T: membership + per-role model are IDENTICAL across all risk tiers; no max_turns stamped', () => {
        // The function has no RiskTier parameter — invariance is structural. We prove
        // it by building one request per tier (membership is the SAME regardless) and
        // asserting deep equality. Exhaustive over the closed RiskTier set (= property
        // test over the finite domain; fast-check is not a dep here).
        const manifests = ALL_TIERS.map(() => buildPanelManifest('verify'))
        const first = at(manifests, 0)
        for (const m of manifests) {
            expect(m).toEqual(first)
        }
        // Each reviewer runs its FIXED per-role model (Δ T reversal — no longer a
        // single value for every reviewer).
        for (const agent of first.agents) {
            expect(agent.model).toBe(expectedModelFor(agent.role))
            expect(agent.max_turns).toBeUndefined()
        }
    })

    it('D26: every panel role appears exactly once in the request', () => {
        const m = buildPanelManifest('verify')
        const roles = m.agents.map((a) => a.role).sort()
        expect(roles).toEqual([...PANEL_ROLES].sort())
        expect(new Set(roles).size).toBe(roles.length)
    })

    it('WS2 coherence: the request validates through the frozen parseSpawnRequest', () => {
        const m = buildPanelManifest('verify')
        expect(() => parseSpawnRequest(m)).not.toThrow()
        expect(m.resume_phase).toBe('verify')
    })

    describe('3b(iii) verifier_spec template', () => {
        it('stamps agent_type/model/isolation/prompt_template/interpolate_fields on every manifest', () => {
            const m = buildPanelManifest('verify')
            expect(m.verifier_spec?.agent_type).toBe('finding-verifier')
            expect(m.verifier_spec?.model).toBe('sonnet')
            expect(m.verifier_spec?.isolation).toBe('worktree')
            expect(m.verifier_spec?.prompt_template).toContain('{claim}')
            expect(m.verifier_spec?.interpolate_fields).toEqual(['claim', 'file', 'line', 'quote'])
        })

        // ADMISSIBILITY (D27/D44): a field is interpolated iff the verifier can CHECK it
        // against the code. What the reviewer BELIEVED — its reasoning, its confidence,
        // its identity — is checkable against nothing, so none of the three reaches the
        // prompt. A verifier that weighs them is agreeing, not verifying.
        it.each(['description', 'severity', 'reviewer'])(
            'never interpolates the inadmissible field {%s} — anti-anchoring (D27)',
            (field) => {
                const m = buildPanelManifest('verify')
                expect(m.verifier_spec?.interpolate_fields).not.toContain(field)
                expect(m.verifier_spec?.prompt_template).not.toContain(`{${field}}`)
            }
        )

        it("the finding-verifier's model is decoupled from the reviewer panel (fixed sonnet)", () => {
            const m = buildPanelManifest('verify')
            expect(m.verifier_spec?.model).toBe('sonnet')
            // Independent of any reviewer's model — quality-reviewer runs opus, the
            // verifier still runs sonnet.
            const quality = m.agents.find((a) => a.role === 'quality-reviewer')
            expect(quality?.model).toBe('opus')
        })
    })

    describe('S5/C cross-vendor stamp', () => {
        it("present resolution stamps { status: 'present', model, prompt } from the slot", () => {
            const m = buildPanelManifest(
                'verify',
                {status: 'present', slot: {vendor: 'codex', model: 'gpt-5-codex'}},
                false,
                'the composed codex prompt'
            )
            expect(m.cross_vendor).toEqual({
                status: 'present',
                model: 'gpt-5-codex',
                prompt: 'the composed codex prompt',
            })
        })

        it('a present resolution with no crossVendorPrompt fails LOUD (never spawns codex blind)', () => {
            expect(() =>
                buildPanelManifest('verify', {
                    status: 'present',
                    slot: {vendor: 'codex', model: 'gpt-5-codex'},
                })
            ).toThrow()
        })

        it("absent resolution stamps { status: 'absent', reason } verbatim", () => {
            const m = buildPanelManifest('verify', {
                status: 'absent',
                reason: 'no cross-vendor model configured (codex.model)',
            })
            expect(m.cross_vendor).toEqual({
                status: 'absent',
                reason: 'no cross-vendor model configured (codex.model)',
            })
        })

        it('no resolution ⇒ no stamp (key absent, not undefined-valued)', () => {
            const m = buildPanelManifest('verify')
            expect('cross_vendor' in m).toBe(false)
        })

        it('the stamp never changes panel membership or model', () => {
            const stamped = buildPanelManifest('verify', {
                status: 'absent',
                reason: 'r',
            })
            const bare = buildPanelManifest('verify')
            expect(stamped.agents).toEqual(bare.agents)
        })
    })

    describe('Decision 51 content-conditional DB specialist', () => {
        it('panelRolesFor(false) is EXACTLY the four-lens floor', () => {
            expect(panelRolesFor(false)).toEqual(PANEL_ROLES)
        })

        it('panelRolesFor(true) appends database-design-reviewer AFTER the unchanged floor', () => {
            const roles = panelRolesFor(true)
            expect(roles.slice(0, PANEL_ROLES.length)).toEqual(PANEL_ROLES)
            expect(roles).toHaveLength(PANEL_ROLES.length + 1)
            expect(at(roles, roles.length - 1)).toBe(DB_DESIGN_ROLE)
        })

        it('dbApplicable=true builds a 5-agent manifest with the specialist on its fixed model', () => {
            const m = buildPanelManifest('verify', undefined, true)
            expect(m.agents).toHaveLength(PANEL_ROLES.length + 1)
            const db = m.agents.find((a) => a.role === DB_DESIGN_ROLE)
            expect(db).toBeDefined()
            expect(db?.model).toBe('opus')
            expect(db?.max_turns).toBeUndefined()
            expect(db?.isolation).toBe('worktree')
            expect(() => parseSpawnRequest(m)).not.toThrow()
        })

        it('dbApplicable defaults to false — pre-existing callers keep the exact floor', () => {
            expect(buildPanelManifest('verify').agents.map((a) => a.role)).toEqual([...PANEL_ROLES])
        })

        it('additive-only: the floor agents are byte-identical with and without the specialist', () => {
            const withDb = buildPanelManifest('verify', undefined, true)
            const bare = buildPanelManifest('verify')
            expect(withDb.agents.slice(0, PANEL_ROLES.length)).toEqual(bare.agents)
        })
    })
})
