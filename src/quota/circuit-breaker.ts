/**
 * WS4 — Pure run-level safety breaker (ported from `bin/pipeline-circuit-breaker`,
 * decoupled from quota windows).
 *
 * This is a HARD run-abort predicate, DISTINCT from the pacer: the pacer produces
 * pause/suspend (a recoverable quota event); the breaker produces a tripped/no
 * verdict the orchestrator turns into a run-level finalize. A quota pause NEVER trips
 * the breaker — paused minutes are deducted from wall time so waiting out a quota
 * curve does not count against the runtime budget.
 *
 * It trips on:
 *   - `cumulativeFailures >= maxConsecutiveFailures` (default 3), and
 *   - effective runtime `(wallMinutes - pausedMinutes) >= maxRuntimeMinutes`
 *     (default 480).
 *
 * The failure signal is run-CUMULATIVE, not strictly consecutive: it is the running
 * count of GENUINE capability-budget failures (the gate excludes cascade/wedge failures —
 * see `circuit-breaker-gate.ts`). The threshold keeps its public config name
 * `maxConsecutiveFailures` for back-compat even though the signal it bounds is
 * cumulative — the INPUT field is named honestly (`cumulativeFailures`).
 *
 * Fail-closed (Decision: H12-class — a corrupt/absent input must TRIP, never leave
 * the breaker disarmed): a non-finite or negative `cumulativeFailures` /
 * `pausedMinutes`, or an unparseable `startedAtIso`, trips.
 *
 * The cumulative-failure count is DERIVED by the orchestrator gate (capability-budget
 * failures) — the frozen RunState has no breaker field; this module is the PURE
 * predicate over values the orchestrator threads in.
 */
import type { Config } from "../config/schema.js";
import { parseIso8601ToEpoch } from "../shared/time.js";

/** Inputs the orchestrator threads into the breaker (counter + timings live in WS8/WS10). */
export interface CircuitBreakerInput {
  /** ISO-8601 run start time. */
  startedAtIso: string;
  /** Cumulative genuine capability-budget task failures so far (non-negative integer). */
  cumulativeFailures: number;
  /** Total minutes the run has spent PAUSED on quota (deducted from wall time). */
  pausedMinutes: number;
}

/** The breaker verdict — a closed union; `tripped: true` carries the human reason. */
export type CircuitBreakerResult = { tripped: false } | { tripped: true; reason: string };

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Evaluate the breaker. Pure; the caller supplies `nowEpoch`. Fail-closed on any
 * malformed input (treated as tripped). Independent of quota.
 */
export function evaluate(
  input: CircuitBreakerInput,
  config: Config,
  nowEpoch: number,
): CircuitBreakerResult {
  const { cumulativeFailures, pausedMinutes, startedAtIso } = input;

  if (!isNonNegativeFinite(cumulativeFailures)) {
    return {
      tripped: true,
      reason: `circuit breaker fail-closed: cumulativeFailures is not a non-negative finite number (got ${String(cumulativeFailures)})`,
    };
  }
  if (!isNonNegativeFinite(pausedMinutes)) {
    return {
      tripped: true,
      reason: `circuit breaker fail-closed: pausedMinutes is not a non-negative finite number (got ${String(pausedMinutes)})`,
    };
  }

  const { maxConsecutiveFailures, maxRuntimeMinutes } = config;

  if (cumulativeFailures >= maxConsecutiveFailures) {
    return {
      tripped: true,
      reason: `max cumulative failures (${cumulativeFailures} >= ${maxConsecutiveFailures})`,
    };
  }

  let startEpoch: number;
  try {
    startEpoch = parseIso8601ToEpoch(startedAtIso);
  } catch {
    return {
      tripped: true,
      reason: `circuit breaker fail-closed: unparseable startedAtIso '${startedAtIso}'`,
    };
  }

  const wallMinutes = Math.floor((nowEpoch - startEpoch) / 60);
  const runtimeMinutes = Math.max(0, wallMinutes - pausedMinutes);
  if (runtimeMinutes >= maxRuntimeMinutes) {
    return {
      tripped: true,
      reason: `max runtime reached (${runtimeMinutes}min >= ${maxRuntimeMinutes}min)`,
    };
  }

  return { tripped: false };
}
