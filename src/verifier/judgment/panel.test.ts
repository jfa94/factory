import {describe, it, expect} from 'vitest'
import {RiskTierEnum, parseSpawnRequest, type RiskTier} from '../../types/index.js'
import {DB_DESIGN_ROLE, PANEL_ROLES, buildPanelManifest, panelRolesFor} from './panel.js'
import {at} from '../../shared/index.js'

const ALL_TIERS: readonly RiskTier[] = RiskTierEnum.options

describe('WS7 risk-invariant panel (D26 / Δ T)', () => {
    it('D43: panel is EXACTLY the 4 fixed consolidated roles', () => {
        expect([...PANEL_ROLES].sort()).toEqual(
            ['implementation-reviewer', 'quality-reviewer', 'silent-failure-hunter', 'systemic-failure-reviewer'].sort()
        )
        expect(PANEL_ROLES.length).toBe(4)
    })

    it('D26 / Δ T: membership, model, and max_turns are IDENTICAL across all risk tiers', () => {
        // The function has no RiskTier parameter — invariance is structural. We prove
        // it by building one request per tier (membership is the SAME regardless) and
        // asserting deep equality. Exhaustive over the closed RiskTier set (= property
        // test over the finite domain; fast-check is not a dep here).
        const manifests = ALL_TIERS.map(() => buildPanelManifest('verify', 'opus', 40))
        const first = at(manifests, 0)
        for (const m of manifests) {
            expect(m).toEqual(first)
        }
        // And the model is a SINGLE fixed value for every reviewer.
        const models = new Set(first.agents.map((a) => a.model))
        expect(models.size).toBe(1)
        expect(at([...models], 0)).toBe('opus')
        // Fixed depth: one max_turns for all.
        const turns = new Set(first.agents.map((a) => a.max_turns))
        expect(turns.size).toBe(1)
        expect(at([...turns], 0)).toBe(40)
    })

    it('D26: every panel role appears exactly once in the request', () => {
        const m = buildPanelManifest('verify', 'opus', 40)
        const roles = m.agents.map((a) => a.role).sort()
        expect(roles).toEqual([...PANEL_ROLES].sort())
        expect(new Set(roles).size).toBe(roles.length)
    })

    it('WS2 coherence: the request validates through the frozen parseSpawnRequest', () => {
        const m = buildPanelManifest('verify', 'opus', 40)
        expect(() => parseSpawnRequest(m)).not.toThrow()
        expect(m.resume_phase).toBe('verify')
    })

    it('Δ T: a blank model fails LOUD at the seam (no malformed request)', () => {
        expect(() => buildPanelManifest('verify', '', 40)).toThrow()
    })

    it('D26: a non-positive max_turns fails LOUD at the seam', () => {
        expect(() => buildPanelManifest('verify', 'opus', 0)).toThrow()
    })

    describe('3b(iii) verifier_spec template', () => {
        it('stamps agent_type/model/isolation/prompt_template/interpolate_fields on every manifest', () => {
            const m = buildPanelManifest('verify', 'opus', 40)
            expect(m.verifier_spec?.agent_type).toBe('general-purpose')
            expect(m.verifier_spec?.model).toBe('opus')
            expect(m.verifier_spec?.isolation).toBe('worktree')
            expect(m.verifier_spec?.prompt_template).toContain('{reviewer}')
            expect(m.verifier_spec?.interpolate_fields).toEqual([
                'reviewer',
                'severity',
                'claim',
                'file',
                'line',
                'quote',
            ])
        })

        it('never interpolates {description} — anti-anchoring (D27)', () => {
            const m = buildPanelManifest('verify', 'opus', 40)
            expect(m.verifier_spec?.interpolate_fields).not.toContain('description')
            expect(m.verifier_spec?.prompt_template).not.toContain('{description}')
        })

        it('reuses the SAME model as the reviewer panel (Δ T)', () => {
            const m = buildPanelManifest('verify', 'sonnet', 40)
            expect(m.verifier_spec?.model).toBe('sonnet')
        })
    })

    describe('S5/C cross-vendor stamp', () => {
        it("present resolution stamps { status: 'present', model, prompt } from the slot", () => {
            const m = buildPanelManifest(
                'verify',
                'opus',
                40,
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
                buildPanelManifest('verify', 'opus', 40, {
                    status: 'present',
                    slot: {vendor: 'codex', model: 'gpt-5-codex'},
                })
            ).toThrow()
        })

        it("absent resolution stamps { status: 'absent', reason } verbatim", () => {
            const m = buildPanelManifest('verify', 'opus', 40, {
                status: 'absent',
                reason: 'no cross-vendor model configured (codex.model)',
            })
            expect(m.cross_vendor).toEqual({
                status: 'absent',
                reason: 'no cross-vendor model configured (codex.model)',
            })
        })

        it('no resolution ⇒ no stamp (key absent, not undefined-valued)', () => {
            const m = buildPanelManifest('verify', 'opus', 40)
            expect('cross_vendor' in m).toBe(false)
        })

        it('the stamp never changes panel membership, model, or turns', () => {
            const stamped = buildPanelManifest('verify', 'opus', 40, {
                status: 'absent',
                reason: 'r',
            })
            const bare = buildPanelManifest('verify', 'opus', 40)
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

        it('dbApplicable=true builds a 5-agent manifest with the SAME model + turns for the specialist', () => {
            const m = buildPanelManifest('verify', 'opus', 40, undefined, true)
            expect(m.agents).toHaveLength(PANEL_ROLES.length + 1)
            const db = m.agents.find((a) => a.role === DB_DESIGN_ROLE)
            expect(db).toBeDefined()
            expect(db?.model).toBe('opus')
            expect(db?.max_turns).toBe(40)
            expect(db?.isolation).toBe('worktree')
            expect(() => parseSpawnRequest(m)).not.toThrow()
        })

        it('dbApplicable defaults to false — pre-existing callers keep the exact floor', () => {
            expect(buildPanelManifest('verify', 'opus', 40).agents.map((a) => a.role)).toEqual([...PANEL_ROLES])
        })

        it('additive-only: the floor agents are byte-identical with and without the specialist', () => {
            const withDb = buildPanelManifest('verify', 'opus', 40, undefined, true)
            const bare = buildPanelManifest('verify', 'opus', 40)
            expect(withDb.agents.slice(0, PANEL_ROLES.length)).toEqual(bare.agents)
        })
    })
})
