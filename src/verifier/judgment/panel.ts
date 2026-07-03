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
 * The panel is the consolidated four-lens set (Decision 43): implementation-reviewer
 * (spec alignment), quality-reviewer (the merged adversarial quality + security +
 * architecture + type-design lens), silent-failure-hunter, and
 * systemic-failure-reviewer. All four roles already exist in the frozen
 * {@link SpawnRoleEnum} — no new role is invented here.
 *
 * Every reviewer runs on the SAME fixed model (Δ T) and the SAME turn budget
 * (D26 fixed depth). The request is validated through the frozen
 * {@link parseSpawnRequest} so it can never drift from the WS2 shape.
 */
import { parseSpawnRequest, type SpawnRequest, type SpawnRole } from "../../types/index.js";

/**
 * The four fixed panel roles, in a stable order. CLOSED: this list IS the panel
 * membership invariant. Each entry is a {@link SpawnRole} from the frozen enum.
 * Exported so the acceptance test asserts the exact set.
 */
export const PANEL_ROLES: readonly SpawnRole[] = [
  "implementation-reviewer",
  "quality-reviewer",
  "silent-failure-hunter",
  "systemic-failure-reviewer",
] as const;

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
  return `reviews/prompts/${role}.md`;
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
 *
 * The output is validated through {@link parseSpawnRequest}; an empty/blank
 * model or non-positive `maxTurns` therefore fails LOUDLY at the seam rather than
 * producing a malformed request. The result is provably independent of any
 * RiskTier because no tier is in scope.
 */
export function buildPanelManifest(
  resumePhase: SpawnRequest["resume_phase"],
  model: string,
  maxTurns: number,
): SpawnRequest {
  const agents = PANEL_ROLES.map((role) => ({
    role,
    isolation: "worktree" as const,
    model,
    max_turns: maxTurns,
    prompt_ref: promptRefFor(role),
  }));
  return parseSpawnRequest({ resume_phase: resumePhase, agents });
}
