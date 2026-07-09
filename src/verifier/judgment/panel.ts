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
 * Each reviewer runs on a FIXED per-role model ({@link REVIEWER_MODEL_BY_ROLE} — a
 * deliberate reversal of the prior single-fixed-reviewer-model decision, Δ T; still
 * keyed only on role, never risk tier, so risk-invariance holds). `max_turns` is
 * NOT stamped on any agent here — each reviewer's own frontmatter is the single
 * source of truth for its turn budget. The request is validated through the frozen
 * {@link parseSpawnRequest} so it can never drift from the WS2 shape.
 */
import {
    parseSpawnRequest,
    AGENT_TYPE_BY_ROLE,
    FINDING_VERIFIER_AGENT_TYPE,
    type SpawnRequest,
    type SpawnRole,
    type VerifierSpec,
} from '../../types/index.js'
import type {CrossVendorResolution} from './vendor.js'

/**
 * Per-role reviewer model (a deliberate reversal of the single-fixed-reviewer-model
 * decision, Δ T — ADR-worthy, see the model/effort/max_turns tuning plan). Still keyed
 * ONLY on role, never risk tier, so risk-invariance (Decision 26) holds: opus for the
 * deepest-reasoning lenses (quality/systemic/database), sonnet for the narrower-scoped
 * ones (spec-alignment/silent-failure). Producer roles are never looked up here — only
 * {@link PANEL_ROLES} + {@link DB_DESIGN_ROLE} keys are ever read.
 */
const REVIEWER_MODEL_BY_ROLE: Partial<Record<SpawnRole, string>> = {
    'implementation-reviewer': 'sonnet',
    'quality-reviewer': 'opus',
    'silent-failure-hunter': 'sonnet',
    'systemic-failure-reviewer': 'opus',
    'database-design-reviewer': 'opus',
}

/** The finding-verifier's fixed model — decoupled from the panel/reviewer model. */
const FINDING_VERIFIER_MODEL = 'sonnet'

/** Look up a panel role's fixed model. Throws on a non-panel role — a programming error. */
function reviewerModelFor(role: SpawnRole): string {
    const model = REVIEWER_MODEL_BY_ROLE[role]
    if (model === undefined) {
        throw new Error(`panel: no reviewer model configured for role '${role}'`)
    }
    return model
}

/**
 * The finding-verifier's fixed framing (3b/iii) — an adversarial "try to refute
 * this" posture, with `{field}` placeholders for EXACTLY the whitelisted
 * per-finding data the runner interpolates. Never `{description}` — the
 * reviewer's reasoning chain must not lead the independent verifier
 * (anti-anchoring, D27).
 */
const VERIFIER_INTERPOLATE_FIELDS = ['reviewer', 'severity', 'claim', 'file', 'line', 'quote'] as const

const VERIFIER_PROMPT_TEMPLATE = `You are an INDEPENDENT finding-verifier (verify-then-fix, D27). Try to REFUTE the
following review finding against the actual code — do not assume it is correct.

Reviewer: {reviewer}
Severity: {severity}
Claim: {claim}
Cited location: {file}:{line}
Quoted source: {quote}

Inspect the cited file/line yourself before deciding. Return EXACTLY one JSON
object as your final message: { "holds": true|false, "note": "<why>" }.`

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
 * Build the risk-INVARIANT panel {@link SpawnRequest}.
 *
 * @param resumePhase the per-task phase the engine resumes at once the panel
 *   returns (the verify phase).
 * @param crossVendor the resolved cross-vendor slot (S5/C, resolveCodexCrossVendor)
 *   — stamped onto the manifest so the runner knows whether to run the
 *   quality-reviewer via `codex exec` (present) or report the absence verbatim.
 *   Omitted ⇒ no stamp (callers that predate the honesty wiring).
 * @param dbApplicable whether the task diff touches DB files (`touchesDatabase`) —
 *   true appends the `database-design-reviewer` specialist (Decision 51). Defaults
 *   to false so pre-existing callers keep the exact four-lens floor.
 * @param crossVendorPrompt the composed codex prompt (3b/ii, {@link
 *   import("./cross-vendor-prompt.js").composeCrossVendorPrompt}) — REQUIRED
 *   when `crossVendor.status === 'present'` (parseSpawnRequest fails loud
 *   otherwise); ignored when absent/omitted.
 *
 * Neither `model` nor `max_turns` is a parameter here: each reviewer's model is
 * the fixed per-role value ({@link REVIEWER_MODEL_BY_ROLE}), and `max_turns` is
 * omitted from every agent spec entirely — the runner falls back to that agent's
 * own frontmatter `maxTurns` (single-source-of-truth). The output is validated
 * through {@link parseSpawnRequest}, so an empty/blank model therefore fails
 * LOUDLY at the seam rather than producing a malformed request. The result is
 * provably independent of any RiskTier because no tier is in scope.
 */
export function buildPanelManifest(
    resumePhase: SpawnRequest['resume_phase'],
    crossVendor?: CrossVendorResolution,
    dbApplicable = false,
    crossVendorPrompt?: string
): SpawnRequest {
    const agents = panelRolesFor(dbApplicable).map((role) => ({
        role,
        agent_type: AGENT_TYPE_BY_ROLE[role],
        isolation: 'worktree' as const,
        model: reviewerModelFor(role),
    }))
    const cross_vendor =
        crossVendor === undefined
            ? undefined
            : crossVendor.status === 'present'
              ? ({status: 'present', model: crossVendor.slot.model, prompt: crossVendorPrompt} as const)
              : ({status: 'absent', reason: crossVendor.reason} as const)
    const verifier_spec: VerifierSpec = {
        agent_type: FINDING_VERIFIER_AGENT_TYPE,
        model: FINDING_VERIFIER_MODEL,
        isolation: 'worktree',
        prompt_template: VERIFIER_PROMPT_TEMPLATE,
        interpolate_fields: [...VERIFIER_INTERPOLATE_FIELDS],
    }
    return parseSpawnRequest({
        resume_phase: resumePhase,
        agents,
        ...(cross_vendor !== undefined ? {cross_vendor} : {}),
        verifier_spec,
    })
}
