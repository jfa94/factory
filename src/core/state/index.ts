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
  DriverEnum,
  EscalationRungSchema,
  // object schemas
  SpecPointerSchema,
  ReviewerResultSchema,
  TaskStateSchema,
  QuotaCheckpointSchema,
  RunStateSchema,
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
  Driver,
  SpecPointer,
  ReviewerResult,
  TaskState,
  QuotaCheckpoint,
  RunState,
} from "./schema.js";

// --- Derive-don't-store gate-verdict accessors ---
export {
  deriveGateVerdict,
  deriveAllGatesVerdict,
  derivePanelVerdict,
  deriveFloorVerdict,
} from "./derive.js";
export type { GateEvidence, GateVerdict } from "./derive.js";

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
  CURRENT_LINK,
  STATE_FILE,
  repoKey,
  runsRoot,
  runDir,
  runStatePath,
  currentLinkPath,
  specsRoot,
  specDir,
} from "./paths.js";
