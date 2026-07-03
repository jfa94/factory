/**
 * The run-level CIRCUIT-BREAKER gate — the orchestrator-layer wiring of the pure
 * {@link evaluate} predicate (`quota/circuit-breaker.ts`) into the run orchestrator.
 * Mirrors the {@link import("./quota-gate.js").applyQuotaGate} DI shape: a narrow
 * deps subset, evaluated over fresh state by `runId`, returning a structured verdict
 * or null to proceed. Never writes state — turning a trip into failures is the CALLER's
 * job (`nextTask`), exactly as the quota gate leaves recovery to its caller.
 *
 * A tripped verdict is a HARD abort — every remaining non-terminal task is failed
 * (loud, classified) and the run falls through to `all-terminal` → finalize →
 * `failed`, reusing the proven Decision-34 wedge-fail path.
 *
 * This gate supplies the pure breaker the one signal it cannot derive itself,
 * derived honestly from run state (derive-don't-store — no breaker counter persisted):
 * the count of `capability-budget` failures — tasks whose producer escalation ladder
 * genuinely exhausted its budget. We deliberately EXCLUDE `blocked-environmental`
 * (dependency cascades) and `spec-defect` (wedge) failures: those are CONSEQUENCES
 * of a failure, not independent failures. Counting them would let ONE real failure
 * that cascades to two dependents masquerade as three "consecutive" failures and
 * abort still-runnable independent work — directly against the highest-quality-code
 * objective. (The signal is run-cumulative, not strictly consecutive: once N tasks
 * have GENUINELY failed, the run is pathological enough to abort in lights-out mode;
 * the cap is configurable.)
 */
import { evaluate, type CircuitBreakerResult } from "../quota/circuit-breaker.js";
import type { Config, StateManager } from "./deps.js";

/** A tripped breaker verdict (the human reason) — the gate's only non-null return. */
export type CircuitBreakerTrip = Extract<CircuitBreakerResult, { tripped: true }>;

/** The narrow deps the breaker gate needs (a subset of {@link import("./orchestrator.js").OrchestratorDeps}). */
export interface CircuitBreakerGateDeps {
  readonly state: StateManager;
  readonly config: Config;
}

/**
 * Evaluate the run-level breaker over fresh state. Returns the tripped verdict
 * (carrying the human reason) or null to proceed. Pure w.r.t. state — never writes.
 */
export async function applyCircuitBreaker(
  deps: CircuitBreakerGateDeps,
  runId: string,
): Promise<CircuitBreakerTrip | null> {
  const run = await deps.state.read(runId);

  // Genuine producer-capability exhaustion only (see header).
  const capabilityFailures = Object.values(run.tasks).filter(
    (t) => t.status === "failed" && t.failure_class === "capability-budget",
  ).length;

  const verdict = evaluate({ cumulativeFailures: capabilityFailures }, deps.config);
  return verdict.tripped ? verdict : null;
}
