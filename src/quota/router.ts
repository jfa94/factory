/**
 * WS4 — The quota-router (the renamed `pipeline-model-router`, NARROWED).
 *
 * Per Decision 25/26 the review panel is risk-INVARIANT: the old `--tier`
 * routine/feature/security review-round caps are DELETED. This router therefore
 * carries the SINGLE producer dial — it selects a producer MODEL from the task's
 * {@link RiskTier} — and exposes NO review-depth/round output. The verifier floor
 * is untouched by this module.
 *
 * {@link quotaGate} is the thin combined entrypoint: run the pacer, and on
 * `proceed` return the routed producer model; on a pause/suspend/halt return the
 * graceful-stop StageResult and NO model (the run is not producing). Pure given
 * config + reading.
 */
import type { Config } from "../config/schema.js";
import type { RiskTier, GracefulStopResult } from "../types/index.js";
import { assertNever } from "../types/index.js";
import type { UsageReading } from "./usage-source.js";
import { evaluate as evaluatePacer } from "./pacer.js";
import { decisionToStageResult } from "./to-stage-result.js";

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

/**
 * The result of the combined quota gate. On `proceed`, a producer model is
 * routed and there is no stop. Otherwise a {@link GracefulStopResult} is carried
 * and there is NO model — the run pauses/suspends/halts rather than produces.
 */
export type QuotaGateResult =
  | { kind: "proceed"; producerModel: string }
  | { kind: "stop"; stop: GracefulStopResult };

/**
 * Run the pacer and route. Pure given config + reading + clock. On `proceed`
 * returns the producer model for `riskTier`; otherwise returns the graceful-stop
 * StageResult (quota's only StageResult — never partial/drop).
 */
export function quotaGate(
  reading: UsageReading,
  riskTier: RiskTier,
  config: Config,
  nowEpoch: number,
): QuotaGateResult {
  const decision = evaluatePacer(reading, config, nowEpoch);
  const stop = decisionToStageResult(decision);
  if (stop === null) {
    return { kind: "proceed", producerModel: selectProducerModel(riskTier, config) };
  }
  return { kind: "stop", stop };
}
