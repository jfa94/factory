/**
 * WS4 — Public barrel for `src/quota` (Decision 24, Δ E/F). WS10 imports the whole
 * quota seam from this one path. Quota-owned ONLY: it imports FROM the frozen
 * `src/types` barrel but never re-exports or mutates it.
 *
 * The architecture, top to bottom:
 *   - usage-source : the injectable {@link UsageSignal} + fail-closed reader.
 *   - window       : pure two-window position + threshold math.
 *   - pacer        : the pure two-window decision → {@link QuotaDecision}.
 *   - to-stage-result : the ONE adapter to the frozen StageResult (gracefulStop only).
 *   - checkpoint   : typed RunState patches honoring the quota-IFF-paused invariant.
 *   - circuit-breaker : the pure run-level hard-abort predicate (distinct from pacing).
 *   - router       : the narrowed quota-router (producer dial only).
 *   - resume       : the human-invoked resume seam (no v2 scheduler).
 */

// Usage signal seam + reader
export {
  StatuslineUsageSignal,
  fakeUsageSignal,
  readingFromCache,
  usageCachePath,
  STALE_CEILING_SECONDS,
  STALE_WARN_SECONDS,
} from "./usage-source.js";
export type {
  UsageSignal,
  UsageReading,
  WindowUsage,
  UnavailableReason,
  StatuslineUsageOptions,
} from "./usage-source.js";

// Window math
export {
  computeWindowHour,
  computeWindowDay,
  hourlyThresholdFor,
  dailyThresholdFor,
  FIVE_HOUR_WINDOW_SECONDS,
  SEVEN_DAY_WINDOW_SECONDS,
} from "./window.js";

// Pacer
export { evaluate } from "./pacer.js";
export type { QuotaDecision } from "./pacer.js";

// StageResult adapter
export { decisionToStageResult } from "./to-stage-result.js";

// Checkpoint patches
export { buildCheckpoint, clearCheckpoint } from "./checkpoint.js";
export type {
  CheckpointableDecision,
  CheckpointPatch,
  ClearCheckpointPatch,
} from "./checkpoint.js";

// Circuit breaker
export { evaluate as evaluateCircuitBreaker } from "./circuit-breaker.js";
export type { CircuitBreakerInput, CircuitBreakerResult } from "./circuit-breaker.js";

// Quota-router
export { selectProducerModel, quotaGate } from "./router.js";
export type { QuotaGateResult } from "./router.js";

// Resume seam
export { planResume } from "./resume.js";
export type { ResumePlan } from "./resume.js";
