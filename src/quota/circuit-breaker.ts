/**
 * WS4 — Pure run-level safety breaker (ported from `bin/pipeline-circuit-breaker`,
 * decoupled from quota windows).
 *
 * This is a HARD run-abort predicate, DISTINCT from the pacer: the pacer produces
 * pause/suspend (a recoverable quota event); the breaker produces a tripped/no
 * verdict the driver turns into a run-level finalize. A quota pause NEVER trips
 * the breaker — paused minutes are deducted from wall time so waiting out a quota
 * curve does not count against the runtime budget.
 *
 * It trips on:
 *   - `consecutiveFailures >= maxConsecutiveFailures` (default 3), and
 *   - effective runtime `(wallMinutes - pausedMinutes) >= maxRuntimeMinutes`
 *     (default 480).
 *
 * Fail-closed (Decision: H12-class — a corrupt/absent input must TRIP, never leave
 * the breaker disarmed): a non-finite or negative `consecutiveFailures` /
 * `pausedMinutes`, or an unparseable `startedAtIso`, trips.
 *
 * The consecutive-failure COUNTER lives in WS8/WS10 state (the frozen RunState has
 * no breaker field); this module is the PURE predicate over values the driver
 * threads in.
 */
import type { Config } from "../config/schema.js";
import { parseIso8601ToEpoch } from "../shared/time.js";

/** Inputs the driver threads into the breaker (counter + timings live in WS8/WS10). */
export interface CircuitBreakerInput {
  /** ISO-8601 run start time. */
  startedAtIso: string;
  /** Consecutive task failures so far (non-negative integer). */
  consecutiveFailures: number;
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
  const { consecutiveFailures, pausedMinutes, startedAtIso } = input;

  if (!isNonNegativeFinite(consecutiveFailures)) {
    return {
      tripped: true,
      reason: `circuit breaker fail-closed: consecutiveFailures is not a non-negative finite number (got ${String(consecutiveFailures)})`,
    };
  }
  if (!isNonNegativeFinite(pausedMinutes)) {
    return {
      tripped: true,
      reason: `circuit breaker fail-closed: pausedMinutes is not a non-negative finite number (got ${String(pausedMinutes)})`,
    };
  }

  const { maxConsecutiveFailures, maxRuntimeMinutes } = config;

  if (consecutiveFailures >= maxConsecutiveFailures) {
    return {
      tripped: true,
      reason: `max consecutive failures (${consecutiveFailures} >= ${maxConsecutiveFailures})`,
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
