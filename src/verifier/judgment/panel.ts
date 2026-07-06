/**
 * WS7 — the RISK-INVARIANT judgment panel (Decision 26 / Δ T / Δ K).
 *
 * THE LOAD-BEARING PROPERTY: panel membership, model, and turn budget are
 * CONSTANT for every task regardless of its `risk_tier`. The producer dial
 * (risk_tier) sizes the PRODUCER ladder (Decision 25); it does NOT size the
 * verifier — the merge gate is risk-invariant (Decision 26). To make that property
 * structurally true rather than merely tested, {@link buildPanelManifest} has NO
 * RiskTier parameter at all: there is nowhere to branch on the tier, so two tasks
 * of different tiers necessarily get a deep-equal request.
 *
 * CONTENT-CONDITIONAL EXCEPTION (Decision 51): `dbApplicable` appends the
 * `database-design-reviewer` specialist when the task diff touches migration/schema
 * files (db-detect.ts). This does NOT weaken risk-invariance: the trigger is a
 * deterministic fact about diff CONTENT (re-derivable from the worktree tip), not a
 * risk-tier judgment, and it is strictly ADDITIVE — the four-lens floor always runs;
 * a DB-touching task gets floor + specialist. Review only ever gets stricter.
 *
 * The floor panel is the consolidated four-lens set (Decision 43): implementation-reviewer
 * (spec alignment), quality-reviewer (the merged adversarial quality + security +
 * architecture + type-design lens), silent-failure-hunter, and
 * systemic-failure-reviewer. All roles already exist in the frozen
 * {@link SpawnRoleEnum} — no new role is invented here.
 *
 * Every reviewer runs on the SAME fixed model (Δ T) and the SAME turn budget
 * (D26 fixed depth). The request is validated through the frozen
 * {@link parseSpawnRequest} so it can never drift from the WS2 shape.
 */
import {parseSpawnRequest, AGENT_TYPE_BY_ROLE, type SpawnRequest, type SpawnRole} from '../../types/index.js'
import type {CrossVendorResolution} from './vendor.js'

/**
 * The four fixed panel roles, in a stable order. CLOSED: this list IS the panel
 * membership FLOOR invariant — it never shrinks and never branches on tier. Each
 * entry is a {@link SpawnRole} from the frozen enum. Exported so the acceptance
 * test asserts the exact set.
 */
export const PANEL_ROLES: readonly SpawnRole[] = [
    'implementation-reviewer',
    'quality-reviewer',
    'silent-failure-hunter',
    'systemic-failure-reviewer',
] as const

/** The content-conditional schema specialist (Decision 51). */
export const DB_DESIGN_ROLE: SpawnRole = 'database-design-reviewer'

/**
 * The expected panel roster for one task: the fixed floor, plus the
 * `database-design-reviewer` specialist iff the task diff touches DB files
 * (`touchesDatabase`, db-detect.ts). The ONLY sanctioned way to size the panel —
 * both the spawn site and the roster-enforcement site derive through here so
 * they cannot disagree.
 */
export function panelRolesFor(dbApplicable: boolean): readonly SpawnRole[] {
    return dbApplicable ? [...PANEL_ROLES, DB_DESIGN_ROLE] : PANEL_ROLES
}

/**
 * The `prompt_ref` placeholder for a panel reviewer. The WS2 AgentSpecSchema
 * requires a non-empty `prompt_ref` on EVERY agent, but — UNLIKE producers, whose
 * `prompt_ref` points at a real per-run ProducerContext artifact the runner Reads
 * (handlers.ts `producerSpawn` → `putProducerContext`) — NO orchestrator reads this value
 * for a reviewer. Both runners (the session `pipeline-runner` SKILL.md panel
 * step and `scripts/factory-run-runner.js`) build the reviewer prompt INLINE
 * from the reviewer's `agents/<role>.md` definition plus the shared
 * `skills/review-protocol/SKILL.md` contract; the reviewer's lens lives in its agent
 * definition + the static protocol, so there is no per-run reviewer prompt file to
 * point at. This returns a stable, role-derived value purely to satisfy the schema's
 * non-empty constraint — it is NOT a readable artifact (CP2 #7: nothing writes a
 * `reviews/prompts/<role>.md` file, and no runner should try to Read one).
 */
function promptRefFor(role: SpawnRole): string {
    return `reviews/prompts/${role}.md`
}

/**
 * Build the risk-INVARIANT panel {@link SpawnRequest}.
 *
 * @param resumePhase the per-task phase the engine resumes at once the panel
 *   returns (the verify phase).
 * @param model the FIXED reviewer model — a SINGLE value used for ALL four
 *   reviewers (resolve via {@link resolveReviewModel}). Deliberately not a
 *   per-role map: every reviewer runs the same model (Δ T).
 * @param maxTurns the FIXED deep-review turn budget for ALL reviewers (D26).
 * @param crossVendor the resolved cross-vendor slot (S5/C, resolveCodexCrossVendor)
 *   — stamped onto the manifest so the runner knows whether to run the
 *   quality-reviewer via `codex exec` (present) or report the absence verbatim.
 *   Omitted ⇒ no stamp (callers that predate the honesty wiring).
 * @param dbApplicable whether the task diff touches DB files (`touchesDatabase`) —
 *   true appends the `database-design-reviewer` specialist (Decision 51). Defaults
 *   to false so pre-existing callers keep the exact four-lens floor.
 *
 * The output is validated through {@link parseSpawnRequest}; an empty/blank
 * model or non-positive `maxTurns` therefore fails LOUDLY at the seam rather than
 * producing a malformed request. The result is provably independent of any
 * RiskTier because no tier is in scope.
 */
export function buildPanelManifest(
    resumePhase: SpawnRequest['resume_phase'],
    model: string,
    maxTurns: number,
    crossVendor?: CrossVendorResolution,
    dbApplicable = false
): SpawnRequest {
    const agents = panelRolesFor(dbApplicable).map((role) => ({
        role,
        agent_type: AGENT_TYPE_BY_ROLE[role],
        isolation: 'worktree' as const,
        model,
        max_turns: maxTurns,
        prompt_ref: promptRefFor(role),
    }))
    const cross_vendor =
        crossVendor === undefined
            ? undefined
            : crossVendor.status === 'present'
              ? ({status: 'present', model: crossVendor.slot.model} as const)
              : ({status: 'absent', reason: crossVendor.reason} as const)
    return parseSpawnRequest({
        resume_phase: resumePhase,
        agents,
        ...(cross_vendor !== undefined ? {cross_vendor} : {}),
    })
}
