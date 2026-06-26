/**
 * WS10 — the driver's PUBLIC barrel.
 *
 * The Model-A driver engine: the deterministic SEAM the CLI/orchestrator drives —
 * the per-task coroutine ({@link nextAction}), the run-level coroutine ({@link nextTask}), the
 * record cores, the quota gate, and the finalize coordinator — plus the reporter
 * dependency-bundle types those callers wire against. `deps.ts` stays INTERNAL (it
 * is the driver's own deep-import barrel); consumers import the frozen seams from
 * `src/types` and each domain barrel, and the driver-specific shapes from here.
 */

// -- the run FINALIZE coordinator (rollup + report + issues; WS12) ------------
export { finalizeRun } from "./finalize.js";
export type { FinalizeRunDeps, FinalizeRunResult } from "./finalize.js";

// -- the shared deterministic transition logic (the coroutines build on these) ------
export {
  dropTask,
  applyProducerOutcome,
  type TransitionDeps,
  type TaskOutcome,
  type TaskStep,
} from "./transitions.js";

// -- shared reporter helpers --------------------------------------------------
export { specTaskOf, shipBody } from "./handlers.js";

// -- dependency-bundle types (the reporter deps the coroutines + CLI wire) ----------
export type { ShipMode, HandlerDeps } from "./types.js";

// -- prompt-artifact store (the prompt_ref round-trip) -----------------------
export { InMemoryArtifactStore, FsArtifactStore } from "./artifacts.js";
export type { ArtifactStore } from "./artifacts.js";

// -- record cores (the coroutine's deterministic result-record kernels) ----------------
export {
  readJsonInput,
  applyRecordProducer,
  applyRecordHoldout,
  applyRecordReviews,
  type RecordDeps,
  type TransitionEnvelope,
  type RecordHoldoutInput,
  type RecordHoldoutEnvelope,
  type VerifierVerdictInput,
  type ReviewerVerifications,
  type RecordReviewsInput,
  type RecordReviewsEnvelope,
} from "./record.js";

// -- drive results schema (factory drive --results input) --------------------
export { DriveResultsSchema, parseDriveResults, type DriveResults } from "./results.js";

// -- quota gate (shared by both coroutines) ----------------------------------------
export { applyQuotaGate, type QuotaGateDeps, type QuotaStop } from "./quota-gate.js";

// -- per-task coroutine (factory drive seam) ----------------------------
export {
  nextAction,
  holdoutSidecar,
  MERGE_RESYNC_CAP,
  type CoroutineDeps,
  type NextAction,
  type HoldoutSpawn,
  type DriveExpects,
} from "./coroutine.js";

// -- run-level coroutine (factory next seam) --------------------------------------
export { nextTask, type NextTask } from "./next.js";

// -- docs phase emit + record coroutines (factory run docs seam) -----------------
export {
  runDocsEmit,
  runDocsRecord,
  docsWorktreePath,
  DocsResultsSchema,
  type DocsRunDeps,
  type DocsAction,
  type DocsResults,
} from "./docs.js";
