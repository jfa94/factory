/**
 * WS8 — the producer MODEL dial + escalation derivation (Decision 21/25, Δ D22/D25).
 *
 * THE SINGLE "change a variable" SOURCE for the escalation ladder. A task's
 * starting model is the WS4 dial output {@link selectProducerModel}(risk_tier,
 * config) — read from config.quota.producerModels, NEVER a literal. Each
 * escalation rung must CHANGE A VARIABLE (Decision 25 — "never a blind re-roll"):
 *
 *   - Rung 0 — the dialed model for the task's risk tier, fresh context.
 *   - Rung 1 — the SAME dialed model, FRESH context (the changed variable is the
 *              context, not the model — a same-tier re-attempt with a clean slate).
 *   - Rung 2 — an ESCALATED model: the next tier UP the producerModels ladder
 *              (low→medium→high), PLUS injected prior-failure context. When the
 *              dial is already at the ceiling (`high`), the model cannot climb
 *              further, so the changed variable is the injected context alone. The
 *              ladder's {@link import("./ladder.js").assertRungChange} derives
 *              whether the model changed (cur.model !== prev.model) — it is NOT
 *              stored on the result (derive-don't-store, Δ V).
 *
 * The escalated model is derived from the SAME config.quota.producerModels map
 * (no new literal, no new config knob): low's escalation is medium, medium's is
 * high, high's is high (ceiling). This keeps the dial fully config-sourced and
 * makes a config override of producerModels flow through every rung.
 */
import type { Config } from "../types/index.js";
import type { RiskTier } from "../types/index.js";
import { selectProducerModel } from "../quota/index.js";

/** The producer-model ladder, low→high (the escalation order up the dial). */
const TIER_LADDER: readonly RiskTier[] = ["low", "medium", "high"] as const;

/** The result of dialing a model for a given rung. */
export interface DialResult {
  /** The model to spawn the producer on at this rung. */
  readonly model: string;
  /** The rung this was dialed for (0 = starting). */
  readonly rung: number;
  /**
   * True iff this rung injects prior-failure "don't do this" context (rung ≥ 2).
   * The second changeable variable. Together with `escalated`, the ladder asserts
   * (escalated || injectsPriorFailure) on every retry rung.
   */
  readonly injectsPriorFailure: boolean;
}

/**
 * Escalate a tier ONE step up the producerModels ladder. low→medium, medium→high,
 * high→high (the ceiling; no tier above `high` in the closed RiskTierEnum).
 */
function escalateTier(tier: RiskTier): RiskTier {
  const idx = TIER_LADDER.indexOf(tier);
  // idx is always found (RiskTier is closed); the `?? tier` guards
  // noUncheckedIndexedAccess on the ceiling step.
  const next = TIER_LADDER[Math.min(idx + 1, TIER_LADDER.length - 1)];
  return next ?? tier;
}

/**
 * Dial the producer model + escalation flags for a given rung off the task's
 * risk tier (Decision 25). Pure given config.
 *
 * @param riskTier the task's spec-time risk tier (the producer dial input).
 * @param rung     the escalation rung (0 = starting, 1 = same-model fresh
 *                 context, 2 = escalate model + inject prior-failure context).
 * @param config   the resolved config (the dial reads quota.producerModels).
 */
export function dialForRung(riskTier: RiskTier, rung: number, config: Config): DialResult {
  if (rung < 0 || !Number.isInteger(rung)) {
    throw new Error(`dialForRung: rung must be a non-negative integer, got ${rung}`);
  }

  const baseModel = selectProducerModel(riskTier, config);

  // Rung 0 and rung 1 run the SAME dialed model. Rung 1's changed variable is the
  // FRESH context (handled by prompt-context.ts), not the model.
  if (rung <= 1) {
    return {
      model: baseModel,
      rung,
      injectsPriorFailure: false,
    };
  }

  // Rung ≥ 2: escalate the model one tier up the SAME producerModels map and
  // inject the prior-failure context. The escalated model is derived from config,
  // never a new literal.
  const escalatedTier = escalateTier(riskTier);
  const escalatedModel = selectProducerModel(escalatedTier, config);
  return {
    model: escalatedModel,
    rung,
    injectsPriorFailure: true,
  };
}
