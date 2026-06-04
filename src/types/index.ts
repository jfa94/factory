/**
 * `src/types` — the agreed home for cross-domain "seam" types.
 *
 * Created in WS0 so downstream imports resolve to a STABLE path and Group-1
 * workstreams don't churn import paths later. WS0 seeds only what it owns;
 * later workstreams ADD to this barrel:
 *   - WS1 adds `RunState` / `TaskState` (re-exported from src/core/state). [done]
 *   - WS2 adds `StageResult` / `SpawnManifest` (from src/core/stage-machine).
 *
 * Keep this a thin re-export barrel — type definitions live in their owning
 * module; this file just makes the seam addressable from one place.
 */

export { EXIT, isExitCode } from "../cli/exit-codes.js";
export type { ExitCode } from "../cli/exit-codes.js";

export type { ExecResult, ExecOptions } from "../shared/exec.js";

export type { Config } from "../config/schema.js";

// WS1 — state core seam. Re-exported so `(repo, spec-id)`-keyed run state, the
// closed enums (run/task status, failure-class, risk-tier, panel-verdict), and
// the derive-don't-store verdict accessors are addressable from one place.
export {
  RunStatusEnum,
  TaskStatusEnum,
  FailureClassEnum,
  RiskTierEnum,
  PanelVerdictEnum,
  ProducerRoleEnum,
  DriverEnum,
  RunStateSchema,
  TaskStateSchema,
  SpecPointerSchema,
  ReviewerResultSchema,
  QuotaCheckpointSchema,
  parseRunState,
  parseTaskState,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  StateManager,
  deriveGateVerdict,
  deriveAllGatesVerdict,
  derivePanelVerdict,
  deriveFloorVerdict,
} from "../core/state/index.js";

export type {
  RunState,
  TaskState,
  RunStatus,
  TaskStatus,
  FailureClass,
  RiskTier,
  PanelVerdict,
  ProducerRole,
  Driver,
  SpecPointer,
  ReviewerResult,
  QuotaCheckpoint,
  GateEvidence,
  GateVerdict,
} from "../core/state/index.js";

// WS2 — stage-machine seam. A COMPLETE mirror of src/core/stage-machine: the PURE
// per-task stage engine (runStage / nextStageFor / decideFinalize / StageEngine),
// its result contract (StageResult union + constructors + assertNever), the Zod
// SpawnManifest, the stage vocabulary + helpers, and the fakeable StageHandlers
// interface. The WS10 session driver and v2 Workflow driver import the engine
// entry points from HERE — keep this barrel a full mirror so no caller must
// deep-import (the "addressable from one place" contract, mirrors the WS1
// StateManager precedent above).
export {
  // stage vocabulary
  TaskStageEnum,
  RunStageEnum,
  TASK_STAGE_ORDER,
  nextStage,
  stageToInFlightStatus,
  // spawn manifest (Zod)
  SpawnRoleEnum,
  SpawnAgentSchema,
  SpawnManifestSchema,
  parseSpawnManifest,
  // result union: exhaustiveness primitive + constructors
  assertNever,
  isTerminalResult,
  advance,
  spawn,
  gracefulStop,
  waitRetry,
  taskDone,
  taskDropped,
  finalizeTerminal,
  // the engine
  runStage,
  nextStageFor,
  decideFinalize,
  StageEngine,
} from "../core/stage-machine/index.js";

export type {
  TaskStage,
  RunStage,
  SpawnRole,
  SpawnAgent,
  SpawnManifest,
  StageResult,
  AdvanceResult,
  SpawnAgentsResult,
  GracefulStopResult,
  WaitRetryResult,
  TaskTerminalResult,
  FinalizeTerminalResult,
  StageContext,
  StageHandlers,
  EngineStage,
} from "../core/stage-machine/index.js";
