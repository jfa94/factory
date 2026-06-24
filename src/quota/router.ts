/**
 * WS4 — The quota-router (the renamed `pipeline-model-router`, NARROWED).
 *
 * Per Decision 25/26 the review panel is risk-INVARIANT: the old `--tier`
 * routine/feature/security review-round caps are DELETED. This router therefore
 * carries the SINGLE producer dial — it selects a producer MODEL from the task's
 * {@link RiskTier} — and exposes NO review-depth/round output. The merge gate
 * is untouched by this module.
 *
 * Pacing (the two-window gate) lives in `pacer`; the driver's `applyQuotaGate`
 * (src/driver/quota-gate.ts) runs it and acts on the decision. This module is the
 * pure producer dial only.
 */
import type { Config } from "../config/schema.js";
import type { RiskTier } from "../types/index.js";
import { assertNever } from "../types/index.js";

/**
 * Select the producer model for a task from its risk tier (Decision 25). This is
 * the only dial — there is no review-depth axis. Reads
 * `config.quota.producerModels`.
 */
export function selectProducerModel(riskTier: RiskTier, config: Config): string {
  const models = config.quota.producerModels;
  switch (riskTier) {
    case "low":
      return models.low;
    case "medium":
      return models.medium;
    case "high":
      return models.high;
    default:
      return assertNever(riskTier);
  }
}
