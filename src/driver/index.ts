/**
 * WS10 — the driver's PUBLIC barrel.
 *
 * The Model-A driver engine: the deterministic SEAM the CLI/orchestrator drives —
 * the per-task pump ({@link pumpTask}), the run-level pump ({@link pumpRun}), the
 * fold cores, the quota gate, and the finalize coordinator — plus the reporter
 * dependency-bundle types those callers wire against. `deps.ts` stays INTERNAL (it
 * is the driver's own deep-import barrel); consumers import the frozen seams from
 * `src/types` and each domain barrel, and the driver-specific shapes from here.
 */

// -- the run FINALIZE coordinator (rollup + report + issues; WS12) ------------
export { finalizeRun } from "./finalize.js";
export type { FinalizeRunDeps, FinalizeRunResult } from "./finalize.js";

// -- the shared deterministic transition logic (the pumps build on these) ------
export {
  dropTask,
  escalateOrDrop,
  classifyProducerFailure,
  applyProducerOutcome,
  type TransitionDeps,
  type TaskOutcome,
  type TaskStep,
} from "./transitions.js";

// -- shared reporter helpers --------------------------------------------------
export { specTaskOf, shipBody } from "./handlers.js";

// -- dependency-bundle types (the reporter deps the pumps + CLI wire) ----------
export type { ShipMode, HandlerDeps } from "./types.js";

// -- prompt-artifact store (the prompt_ref round-trip) -----------------------
export { InMemoryArtifactStore, FsArtifactStore } from "./artifacts.js";
export type { ArtifactStore } from "./artifacts.js";

// -- fold cores (the pump's deterministic result-fold kernels) ----------------
export {
  readJsonInput,
  applyRecordProducer,
  applyRecordHoldout,
  applyRecordReviews,
  type FoldDeps,
  type TransitionEnvelope,
  type RecordHoldoutInput,
  type RecordHoldoutEnvelope,
  type VerifierVerdictInput,
  type ReviewerVerifications,
  type RecordReviewsInput,
  type RecordReviewsEnvelope,
} from "./fold.js";

// -- drive results schema (factory drive --results input) --------------------
export { DriveResultsSchema, parseDriveResults, type DriveResults } from "./results.js";

// -- quota gate (shared by both pumps) ----------------------------------------
export { applyQuotaGate, type QuotaGateDeps, type QuotaStop } from "./quota-gate.js";

// -- per-task coroutine pump (factory drive seam) ----------------------------
export {
  pumpTask,
  holdoutSidecar,
  MERGE_RESYNC_CAP,
  type PumpDeps,
  type DriveEnvelope,
  type HoldoutSidecar,
  type DriveExpects,
} from "./pump.js";

// -- run-level pump (factory next seam) --------------------------------------
export { pumpRun, type NextEnvelope } from "./next.js";
