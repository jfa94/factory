/**
 * WS4 — Pure run-level safety breaker (ported from `bin/pipeline-circuit-breaker`,
 * decoupled from quota windows).
 *
 * This is a HARD run-abort predicate, DISTINCT from the pacer: the pacer produces
 * pause/suspend (a recoverable quota event); the breaker produces a tripped/no
 * verdict the orchestrator turns into a run-level finalize.
 *
 * It trips on `cumulativeFailures >= effectiveThreshold`, where the threshold is
 * PROPORTIONAL to the task-graph size:
 * `max(maxConsecutiveFailures, ceil(FAILURE_RATIO × totalTasks))` — the config key
 * is the FLOOR (default 3; ≤20 tasks behave exactly as the old flat cap; 30 → 5,
 * 40 → 6). This softens the whole-PRD delivery cliff: a fixed cap aborts a large
 * graph on a failure rate a small graph would shrug off.
 *
 * The failure signal is run-CUMULATIVE, not strictly consecutive: it is the running
 * count of GENUINE capability-budget failures (the gate excludes cascade/wedge failures —
 * see `circuit-breaker-gate.ts`). The floor keeps its public config name
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
import type {Config} from '../config/schema.js'

/**
 * Failures tolerated per task in the graph before the run is pathological.
 * Deliberately a module constant, NOT config — no speculative knob; the operator
 * surface is the floor (`maxConsecutiveFailures`).
 */
const FAILURE_RATIO = 0.15

/** Inputs the orchestrator threads into the breaker (counter derived in the gate). */
export interface CircuitBreakerInput {
    /** Cumulative genuine capability-budget task failures so far (non-negative integer). */
    cumulativeFailures: number
    /** Total tasks in the run's task graph (non-negative integer) — sizes the proportional threshold. */
    totalTasks: number
}

/**
 * The breaker verdict — a closed union; `tripped: true` carries the human reason
 * plus which arm fired: `failures` (genuine capability exhaustion) and
 * `fail-closed` (corrupt input) are pathologies that hard-abort the run.
 */
export type CircuitBreakerResult = {tripped: false} | {tripped: true; arm: 'failures' | 'fail-closed'; reason: string}

function isNonNegativeFinite(value: number): boolean {
    return Number.isFinite(value) && value >= 0
}

/**
 * Evaluate the breaker. Pure. Fail-closed on any malformed input (treated as
 * tripped). Independent of quota.
 */
export function evaluate(input: CircuitBreakerInput, config: Config): CircuitBreakerResult {
    const {cumulativeFailures, totalTasks} = input

    if (!isNonNegativeFinite(cumulativeFailures)) {
        return {
            tripped: true,
            arm: 'fail-closed',
            reason: `circuit breaker fail-closed: cumulativeFailures is not a non-negative finite number (got ${String(cumulativeFailures)})`,
        }
    }

    if (!isNonNegativeFinite(totalTasks)) {
        return {
            tripped: true,
            arm: 'fail-closed',
            reason: `circuit breaker fail-closed: totalTasks is not a non-negative finite number (got ${String(totalTasks)})`,
        }
    }

    const {maxConsecutiveFailures} = config
    const proportional = Math.ceil(FAILURE_RATIO * totalTasks)
    const effectiveThreshold = Math.max(maxConsecutiveFailures, proportional)

    if (cumulativeFailures >= effectiveThreshold) {
        const derivation =
            proportional > maxConsecutiveFailures
                ? `ceil(${FAILURE_RATIO} × ${totalTasks} tasks)`
                : `floor maxConsecutiveFailures=${maxConsecutiveFailures}`
        return {
            tripped: true,
            arm: 'failures',
            reason: `max cumulative failures (${cumulativeFailures} >= ${effectiveThreshold}, from ${derivation})`,
        }
    }

    return {tripped: false}
}
