/**
 * WS10 — the driver's PUBLIC barrel.
 *
 * The Model-A driver: REPORTER handlers ({@link makeStageHandlers}) + the ACTOR
 * loop ({@link driveTask}/{@link driveRun}/{@link Driver}) + the spawn mechanics
 * and the dependency-bundle types the CLI (Task C) and the v2 Workflow driver wire
 * against. `deps.ts` stays INTERNAL (it is the driver's own deep-import barrel);
 * consumers import the frozen seams from `src/types` and each domain barrel, and
 * the driver-specific shapes from here.
 */

// -- the loop (actor) --------------------------------------------------------
export { driveTask, driveRun, Driver } from "./loop.js";

// -- the run FINALIZE coordinator (rollup + report + issues; WS12) ------------
export { finalizeRun } from "./finalize.js";
export type { FinalizeRunDeps, FinalizeRunResult } from "./finalize.js";

// -- the shared deterministic transition logic (loop + CLI record-* subcmds) --
export {
  markInFlight,
  completeTask,
  dropTask,
  dropStep,
  escalateOrDrop,
  classifyProducerFailure,
  applyProducerOutcome,
  type TransitionDeps,
  type TaskOutcome,
  type TaskStep,
} from "./transitions.js";

// -- the handlers (reporters) + shared reporter helpers ----------------------
export { makeStageHandlers, specTaskOf, shipBody } from "./handlers.js";

// -- the shared stateful ship pass (loop + CLI run-task ship) -----------------
export { shipTask, type ShipDeps } from "./ship.js";

// -- spawn mechanics (the manifest→runner translation) -----------------------
export { spawnProducer, spawnReviewers, spawnScribe, asProducerRole } from "./agent-runner.js";

// -- dependency-bundle types (reporter deps + loop runners) -------------------
export type {
  ShipMode,
  HandlerDeps,
  DriverRunners,
  DriveDeps,
  ReviewerRunner,
  ReviewerSpawnInput,
  ScribeRunner,
} from "./types.js";

// -- prompt-artifact store (the prompt_ref round-trip) -----------------------
export { InMemoryArtifactStore, FsArtifactStore } from "./artifacts.js";
export type { ArtifactStore } from "./artifacts.js";

// -- per-task worktree path derivation ---------------------------------------
export { taskWorktreePath } from "./paths.js";

// -- fold cores (CLI record-* subcommand kernels + pump) ----------------------
export {
  persistStepCursor,
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

// -- quota gate (shared by pumps + driveRun) ----------------------------------
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
