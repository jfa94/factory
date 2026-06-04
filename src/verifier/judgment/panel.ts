/**
 * WS7 — the RISK-INVARIANT judgment panel (Decision 26 / Δ T / Δ K).
 *
 * THE LOAD-BEARING PROPERTY: panel membership, model, and turn budget are
 * CONSTANT for every task regardless of its `risk_tier`. The producer dial
 * (risk_tier) sizes the PRODUCER ladder (Decision 25); it does NOT size the
 * verifier — the floor is risk-invariant (Decision 26). To make that property
 * structurally true rather than merely tested, {@link buildPanelManifest} has NO
 * RiskTier parameter at all: there is nowhere to branch on the tier, so two tasks
 * of different tiers necessarily get a deep-equal manifest.
 *
 * The panel is the full CCR-pattern set (Δ K): the four classic reviewers
 * (implementation / quality / architecture / security) PLUS silent-failure-hunter
 * and type-design-reviewer. All six roles already exist in the frozen
 * {@link SpawnRoleEnum} — no new role is invented here.
 *
 * Every reviewer runs on the SAME fixed model (Δ T) and the SAME turn budget
 * (D26 fixed depth). The manifest is validated through the frozen
 * {@link parseSpawnManifest} so it can never drift from the WS2 shape.
 */
import { parseSpawnManifest, type SpawnManifest, type SpawnRole } from "../../types/index.js";

/**
 * The six fixed panel roles, in a stable order. CLOSED: this list IS the panel
 * membership invariant. Each entry is a {@link SpawnRole} from the frozen enum.
 * Exported so the acceptance test asserts the exact set.
 */
export const PANEL_ROLES: readonly SpawnRole[] = [
  "implementation-reviewer",
  "quality-reviewer",
  "architecture-reviewer",
  "security-reviewer",
  "silent-failure-hunter",
  "type-design-reviewer",
] as const;

/**
 * Where each panel reviewer's prompt artifact lives, run-store relative. Derived
 * deterministically from the role so the manifest carries a concrete `prompt_ref`
 * (the WS2 schema requires a non-empty pointer). NOT a filesystem path — a
 * run-store-relative pointer, per the WS2 manifest contract.
 */
function promptRefFor(role: SpawnRole): string {
  return `reviews/prompts/${role}.md`;
}

/**
 * Build the risk-INVARIANT panel {@link SpawnManifest}.
 *
 * @param stageAfter the per-task stage the engine resumes at once the panel
 *   returns (the verify stage).
 * @param model the FIXED reviewer model — a SINGLE value used for ALL six
 *   reviewers (resolve via {@link resolveReviewModel}). Deliberately not a
 *   per-role map: every reviewer runs the same model (Δ T).
 * @param maxTurns the FIXED deep-review turn budget for ALL reviewers (D26).
 *
 * The output is validated through {@link parseSpawnManifest}; an empty/blank
 * model or non-positive `maxTurns` therefore fails LOUDLY at the seam rather than
 * producing a malformed manifest. The result is provably independent of any
 * RiskTier because no tier is in scope.
 */
export function buildPanelManifest(
  stageAfter: SpawnManifest["stage_after"],
  model: string,
  maxTurns: number,
): SpawnManifest {
  const agents = PANEL_ROLES.map((role) => ({
    role,
    isolation: "worktree" as const,
    model,
    max_turns: maxTurns,
    prompt_ref: promptRefFor(role),
  }));
  return parseSpawnManifest({ stage_after: stageAfter, agents });
}
