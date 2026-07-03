/**
 * WS4 — Pure run-level safety breaker (ported from `bin/pipeline-circuit-breaker`,
 * decoupled from quota windows).
 *
 * This is a HARD run-abort predicate, DISTINCT from the pacer: the pacer produces
 * pause/suspend (a recoverable quota event); the breaker produces a tripped/no
 * verdict the orchestrator turns into a run-level finalize.
 *
 * It trips on `cumulativeFailures >= maxConsecutiveFailures` (default 3).
 *
 * The failure signal is run-CUMULATIVE, not strictly consecutive: it is the running
 * count of GENUINE capability-budget failures (the gate excludes cascade/wedge failures —
 * see `circuit-breaker-gate.ts`). The threshold keeps its public config name
 * `maxConsecutiveFailures` for back-compat even though the signal it bounds is
 * cumulative — the INPUT field is named honestly (`cumulativeFailures`).
 *
 * Fail-closed (Decision: H12-class — a corrupt/absent input must TRIP, never leave
 * the breaker disarmed): a non-finite or negative `cumulativeFailures` trips.
 *
 * The cumulative-failure count is DERIVED by the orchestrator gate (capability-budget
 * failures) — the frozen RunState has no breaker field; this module is the PURE
 * predicate over values the orchestrator threads in.
 */
import type { Config } from "../config/schema.js";

/** Inputs the orchestrator threads into the breaker (counter derived in the gate). */
export interface CircuitBreakerInput {
  /** Cumulative genuine capability-budget task failures so far (non-negative integer). */
  cumulativeFailures: number;
}

/**
 * The breaker verdict — a closed union; `tripped: true` carries the human reason
 * plus which arm fired: `failures` (genuine capability exhaustion) and
 * `fail-closed` (corrupt input) are pathologies that hard-abort the run.
 */
export type CircuitBreakerResult =
  | { tripped: false }
  | { tripped: true; arm: "failures" | "fail-closed"; reason: string };

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Evaluate the breaker. Pure. Fail-closed on any malformed input (treated as
 * tripped). Independent of quota.
 */
export function evaluate(input: CircuitBreakerInput, config: Config): CircuitBreakerResult {
  const { cumulativeFailures } = input;

  if (!isNonNegativeFinite(cumulativeFailures)) {
    return {
      tripped: true,
      arm: "fail-closed",
      reason: `circuit breaker fail-closed: cumulativeFailures is not a non-negative finite number (got ${String(cumulativeFailures)})`,
    };
  }

  const { maxConsecutiveFailures } = config;

  if (cumulativeFailures >= maxConsecutiveFailures) {
    return {
      tripped: true,
      arm: "failures",
      reason: `max cumulative failures (${cumulativeFailures} >= ${maxConsecutiveFailures})`,
    };
  }

  return { tripped: false };
}
