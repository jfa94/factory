/**
 * The run-level CIRCUIT-BREAKER gate — the orchestrator-layer wiring of the pure
 * {@link evaluate} predicate (`quota/circuit-breaker.ts`) into the run orchestrator.
 * Mirrors the {@link import("./quota-gate.js").applyQuotaGate} DI shape: a narrow
 * deps subset, evaluated over fresh state by `runId`, returning a structured verdict
 * or null to proceed. Never writes state — turning a trip into failures is the CALLER's
 * job (`nextTask`), exactly as the quota gate leaves recovery to its caller.
 *
 * A tripped verdict is a HARD run abort, DISTINCT from the recoverable quota pause:
 * the caller fails every remaining non-terminal task (loud, classified) and falls
 * through to `all-terminal` → finalize → `failed`, reusing the proven Decision-34
 * wedge-fail path (so no new envelope kind / orchestrator change is needed).
 *
 * This gate supplies the pure breaker the two signals it cannot derive itself, each
 * derived honestly from run state (derive-don't-store — no breaker counter persisted):
 *
 *  - FAILURE-COUNT arm (BOTH modes) — the count of `capability-budget` failures: tasks
 *    whose producer escalation ladder genuinely exhausted its budget. We deliberately
 *    EXCLUDE `blocked-environmental` (dependency cascades) and `spec-defect` (wedge)
 *    failures: those are CONSEQUENCES of a failure, not independent failures. Counting
 *    them would let ONE real failure that cascades to two dependents masquerade as
 *    three "consecutive" failures and abort still-runnable independent work — directly
 *    against the highest-quality-code objective. (The signal is run-cumulative, not
 *    strictly consecutive: once N tasks have GENUINELY failed, the run is pathological
 *    enough to abort in lights-out mode; the cap is configurable.)
 *
 *  - RUNTIME arm (WORKFLOW mode ONLY) — wall-time since `run.started_at`. It is exact
 *    only in workflow mode: workflow never pauses on quota (Decision 24), so wall-time
 *    IS the effective runtime. Session mode pauses/suspends, `run.started_at` is never
 *    reset (not by resume, preserved by rescue), and paused minutes are untracked — so
 *    an un-deducted wall clock would falsely trip the ceiling on every resume of a run
 *    older than the cap, breaking suspend/resume. Session mode's time/quota budget is
 *    owned by the usage pacer instead, so we DISARM the runtime ceiling there by
 *    feeding `now` as the start (0 wall minutes → cannot trip). `pausedMinutes` is
 *    therefore always 0: workflow has no pauses to deduct, session has the arm off.
 */
import { evaluate, type CircuitBreakerResult } from "../quota/circuit-breaker.js";
import { epochToIso } from "../shared/time.js";
import type { Config, StateManager } from "./deps.js";

/** A tripped breaker verdict (the human reason) — the gate's only non-null return. */
export type CircuitBreakerTrip = Extract<CircuitBreakerResult, { tripped: true }>;

/** The narrow deps the breaker gate needs (a subset of {@link import("./orchestrator.js").OrchestratorDeps}). */
export interface CircuitBreakerGateDeps {
  readonly state: StateManager;
  readonly config: Config;
  /** Epoch SECONDS. */
  readonly now: () => number;
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
  const now = deps.now();

  // Failure-count arm: genuine producer-capability exhaustion only (see header).
  const capabilityFailures = Object.values(run.tasks).filter(
    (t) => t.status === "failed" && t.failure_class === "capability-budget",
  ).length;

  // Runtime arm: exact only in workflow mode; disarmed in session mode by feeding
  // `now` as the start (→ 0 wall minutes → the runtime branch cannot trip).
  const startedAtIso = run.mode === "workflow" ? run.started_at : epochToIso(now);

  const verdict = evaluate(
    { startedAtIso, cumulativeFailures: capabilityFailures, pausedMinutes: 0 },
    deps.config,
    now,
  );
  return verdict.tripped ? verdict : null;
}
