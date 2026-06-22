/**
 * The producer MODEL + EFFORT dial — the escalation derivation (Decision 21/25).
 *
 * THE SINGLE "change a variable" SOURCE for the escalation ladder. A task's
 * starting model is the dial output {@link selectProducerModel}(risk_tier, config)
 * — read from config.quota.producerModels, NEVER a literal. Each escalation rung
 * must CHANGE A VARIABLE (Decision 25 — "never a blind re-roll"). The ladder climbs
 * the MODEL to its ceiling first, THEN the effort/reasoning level:
 *
 *   - Rung 0 — the dialed model for the task's risk tier, fresh context.
 *   - Rung 1 — the SAME dialed model, FRESH context (the changed variable is the
 *              context, not the model — a same-tier re-attempt with a clean slate).
 *   - Rung ≥ 2 — escalation. JUMP straight to the ceiling model (the `high`-tier
 *              producerModels entry — Opus by default) on the first escalation rung,
 *              then climb effort along {@link EFFORT_LADDER} (`xhigh`→`max`). A task
 *              whose base model already IS the ceiling (a high-tier task) skips the
 *              model-jump step and begins climbing effort immediately. Every
 *              escalation rung also injects prior-failure context. Nothing exists
 *              above `max` effort, so once there the rung saturates — the only
 *              changed variable past the top is the accumulated prior-failure context.
 *
 * Concrete ladders over rungs 0–4 (cap = 4, see {@link ESCALATION_CAP}):
 *   - low / medium base:  base·- → base·- → Opus·- → Opus·xhigh → Opus·max
 *   - high base (=Opus):  Opus·- → Opus·- → Opus·xhigh → Opus·max → Opus·max(sat)
 *
 * The ceiling model is derived from the SAME config.quota.producerModels map (no new
 * literal, no new config knob), so a config override of producerModels flows through
 * every rung. The effort ladder is a hardcoded constant (consistent with the
 * hardcoded {@link ESCALATION_CAP}); its values match the `Agent` effort enum.
 */
import type { Config } from "../types/index.js";
import type { RiskTier } from "../types/index.js";
import { selectProducerModel } from "../quota/index.js";

/**
 * The effort/reasoning ladder climbed once the model has reached its ceiling,
 * weakest→strongest. Values match the `Agent` tool's effort enum and the spec
 * generator's `"max"` pin (Decision 21). Hardcoded (not config) — consistent with
 * the hardcoded {@link ESCALATION_CAP}.
 */
const EFFORT_LADDER: readonly string[] = ["xhigh", "max"] as const;

/** The result of dialing a model + effort for a given rung. */
export interface DialResult {
  /** The model to spawn the producer on at this rung. */
  readonly model: string;
  /** The rung this was dialed for (0 = starting). */
  readonly rung: number;
  /**
   * True iff this rung injects prior-failure "don't do this" context (rung ≥ 2).
   * The second changeable variable. The ladder asserts (model-climbed ||
   * effort-climbed || injectsPriorFailure) on every retry rung.
   */
  readonly injectsPriorFailure: boolean;
  /**
   * The effort/reasoning level to spawn at, climbed ONLY after the model has
   * reached its ceiling. Omitted (`undefined`) on rungs that have not begun the
   * effort climb — the producer then inherits the spawn default (today's behavior).
   */
  readonly effort?: string;
}

/** One step on the escalation ladder: a model, optionally with an effort override. */
interface EscalationStep {
  readonly model: string;
  readonly effort?: string;
}

/**
 * Dial the producer model + effort + escalation flags for a given rung off the
 * task's risk tier (Decision 25). Pure given config.
 *
 * @param riskTier the task's spec-time risk tier (the producer dial input).
 * @param rung     the escalation rung (0 = starting, 1 = same-model fresh context,
 *                 ≥2 = climb model to ceiling then climb effort + inject context).
 * @param config   the resolved config (the dial reads quota.producerModels).
 */
export function dialForRung(riskTier: RiskTier, rung: number, config: Config): DialResult {
  if (rung < 0 || !Number.isInteger(rung)) {
    throw new Error(`dialForRung: rung must be a non-negative integer, got ${rung}`);
  }

  const baseModel = selectProducerModel(riskTier, config);

  // Rungs 0–1 run the SAME dialed model with no effort override. Rung 1's changed
  // variable is the FRESH context (handled by prompt-context.ts), not the dial.
  if (rung <= 1) {
    return { model: baseModel, rung, injectsPriorFailure: false };
  }

  // Rung ≥ 2 — the escalation ladder. Climb the MODEL to its ceiling first (jump
  // straight to the high-tier model), THEN climb effort. The model-jump step is
  // dropped when the base model already IS the ceiling, so a high-tier task begins
  // straight on effort. An index past the end saturates on the strongest step.
  const ceilingModel = selectProducerModel("high", config);
  const effortSteps: EscalationStep[] = EFFORT_LADDER.map((effort) => ({
    model: ceilingModel,
    effort,
  }));
  const steps: readonly EscalationStep[] =
    baseModel === ceilingModel ? effortSteps : [{ model: ceilingModel }, ...effortSteps];

  const step = steps[Math.min(rung - 2, steps.length - 1)];
  if (step === undefined) {
    // Unreachable: `steps` is non-empty and the index is clamped in-range.
    throw new Error(`dialForRung: no escalation step for rung ${rung}`);
  }

  return {
    model: step.model,
    rung,
    injectsPriorFailure: true,
    ...(step.effort !== undefined ? { effort: step.effort } : {}),
  };
}
