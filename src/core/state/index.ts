/**
 * `src/core/state` — the FROZEN state seam. Downstream workstreams import the
 * RunState/TaskState types, the closed enums, the StateManager, and the
 * derive-don't-store accessors from HERE (or re-exported via src/types).
 *
 * Do not break these signatures post-freeze (Group-0 barrier). New fields are
 * ADDITIVE; enum values are a design change, not a casual edit.
 */

// --- Schema: enums, types, parsers ---
export {
  // run status
  RunStatusEnum,
  TERMINAL_RUN_STATUSES,
  NONTERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
  // task status
  TaskStatusEnum,
  TERMINAL_TASK_STATUSES,
  isTerminalTaskStatus,
  // closed enums
  FailureClassEnum,
  RiskTierEnum,
  PanelVerdictEnum,
  ProducerRoleEnum,
  ExecutionModeEnum,
  RunModeEnum,
  ShipModeEnum,
  EscalationRungSchema,
  // object schemas
  SpecPointerSchema,
  ReviewerResultSchema,
  FixFindingSchema,
  TaskStateSchema,
  QuotaCheckpointSchema,
  RunStateSchema,
  // e2e phase (Decision 39)
  E2eSpecKindEnum,
  E2eManifestEntrySchema,
  E2ePhaseSchema,
  // parsers
  parseRunState,
  parseTaskState,
} from "./schema.js";

export type {
  RunStatus,
  TaskStatus,
  FailureClass,
  RiskTier,
  PanelVerdict,
  ProducerRole,
  ExecutionMode,
  RunMode,
  ShipMode,
  SpecPointer,
  ReviewerResult,
  FixFinding,
  TaskState,
  QuotaCheckpoint,
  RunState,
  E2eSpecKind,
  E2eManifestEntry,
  E2ePhase,
} from "./schema.js";

// --- Derive-don't-store gate-verdict accessors ---
export {
  deriveGateVerdict,
  deriveAllGatesVerdict,
  derivePanelVerdict,
  deriveMergeGateVerdict,
  mergeGateBlockReason,
} from "./derive.js";
export type { GateId, EvidenceGate, GateEvidence, GateVerdict } from "./derive.js";

// --- StateManager + path helpers ---
export {
  StateManager,
  type StateManagerOptions,
  type CreateRunArgs,
  type LockTuning,
} from "./manager.js";

export {
  SPECS_DIR,
  RUNS_DIR,
  WORKTREES_DIR,
  CURRENT_LINK,
  CURRENT_DIR,
  STATE_FILE,
  repoKey,
  runsRoot,
  worktreesRoot,
  runDir,
  runStatePath,
  currentLinkPath,
  currentRepoRoot,
  currentRepoLinkPath,
  specsRoot,
  specDir,
} from "./paths.js";
