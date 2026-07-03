/**
 * `src/types` — the agreed home for cross-domain "seam" types.
 *
 * Created in WS0 so downstream imports resolve to a STABLE path and Group-1
 * workstreams don't churn import paths later. WS0 seeds only what it owns;
 * later workstreams ADD to this barrel:
 *   - WS1 adds `RunState` / `TaskState` (re-exported from src/core/state). [done]
 *   - WS2 adds `PhaseResult` / `SpawnRequest` (from src/core/phase-machine).
 *
 * Keep this a thin re-export barrel — type definitions live in their owning
 * module; this file just makes the seam addressable from one place.
 */

export { EXIT, isExitCode } from "../shared/exit-codes.js";
export type { ExitCode } from "../shared/exit-codes.js";

// Trusted Computing Base (TCB) types. These name the shape the hardcoded TCB
// write-deny (src/hooks/tcb.ts, Δ W) and the hook I/O layer share. Their
// definition home is the foundational leaf src/types/tcb.ts — NOT src/hooks — so
// any workstream that needs to reason about the trust boundary imports a STABLE
// seam without reaching up into the hooks enforcement layer (the dependency now
// points hooks → types), and so the closed `TcbCategory` enum is one addressable
// union (a new protected category is a deliberate compile-break, mirroring the
// WS1/WS2 closed-enum discipline). src/hooks/tcb.ts re-exports them for back-compat.
export type { TcbCategory, TcbRule, TcbMatch } from "./tcb.js";

export type { ExecResult, ExecOptions } from "../shared/exec.js";

export type { Config, Effort } from "../config/schema.js";

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
  ExecutionModeEnum,
  RunStateSchema,
  TaskStateSchema,
  SpecPointerSchema,
  ReviewerResultSchema,
  FixFindingSchema,
  QuotaCheckpointSchema,
  E2eSpecKindEnum,
  E2eManifestEntrySchema,
  E2ePhaseSchema,
  E2eAffectedSpecSchema,
  E2eAssessmentSchema,
  parseRunState,
  parseTaskState,
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  StateManager,
  deriveGateVerdict,
  deriveAllGatesVerdict,
  derivePanelVerdict,
  deriveMergeGateVerdict,
  mergeGateBlockReason,
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
  ExecutionMode,
  SpecPointer,
  ReviewerResult,
  FixFinding,
  QuotaCheckpoint,
  GateEvidence,
  GateVerdict,
  E2eSpecKind,
  E2eManifestEntry,
  E2ePhase,
  E2eAdjudicationSpec,
  E2eAdjudication,
  E2eAffectedSpec,
  E2eAssessment,
} from "../core/state/index.js";

// WS2 — phase-machine seam. A COMPLETE mirror of src/core/phase-machine: the PURE
// per-task phase engine (runPhase / nextPhaseFor / decideFinalize),
// its result contract (PhaseResult union + constructors + assertNever), the Zod
// SpawnRequest, the phase vocabulary + helpers, and the fakeable PhaseHandlers
// interface. The WS10 session runner and v2 Workflow runner import the engine
// entry points from HERE — keep this barrel a full mirror so no caller must
// deep-import (the "addressable from one place" contract, mirrors the WS1
// StateManager precedent above).
export {
  // phase vocabulary
  TaskPhaseEnum,
  RunPhaseEnum,
  TASK_PHASE_ORDER,
  nextPhase,
  phaseToInFlightStatus,
  // spawn request (Zod)
  SpawnRoleEnum,
  AgentSpecSchema,
  SpawnRequestSchema,
  parseSpawnRequest,
  // result union: exhaustiveness primitive + constructors
  assertNever,
  isTerminalResult,
  advance,
  spawn,
  gracefulStop,
  waitRetry,
  taskDone,
  taskFailed,
  finalizeTerminal,
  // the engine
  runPhase,
  nextPhaseFor,
  decideFinalize,
} from "../core/phase-machine/index.js";

export type {
  TaskPhase,
  RunPhase,
  SpawnRole,
  AgentSpec,
  SpawnRequest,
  PhaseResult,
  AdvanceResult,
  SpawnAgentsResult,
  GracefulStopResult,
  WaitRetryResult,
  TaskTerminalResult,
  FinalizeTerminalResult,
  PhaseContext,
  PhaseHandlers,
  EnginePhase,
} from "../core/phase-machine/index.js";
