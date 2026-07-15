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
    ShipModeEnum,
    EscalationRungSchema,
    // object schemas
    SpecPointerSchema,
    ReviewerResultSchema,
    FixFindingSchema,
    ReviewDispositionSchema,
    TaskStateSchema,
    QuotaCheckpointSchema,
    MissSchema,
    RunStateSchema,
    // e2e phase (Decision 39)
    E2eSpecKindEnum,
    E2eManifestEntrySchema,
    E2ePhaseSchema,
    E2eAffectedSpecSchema,
    E2eAssessmentSchema,
    // parsers
    parseRunState,
    parseTaskState,
} from './schema.js'

export type {
    RunStatus,
    TaskStatus,
    FailureClass,
    RiskTier,
    PanelVerdict,
    ProducerRole,
    ExecutionMode,
    ShipMode,
    SpecPointer,
    ReviewerResult,
    FixFinding,
    ReviewDisposition,
    TaskState,
    QuotaCheckpoint,
    Miss,
    RunState,
    E2eSpecKind,
    E2eManifestEntry,
    E2ePhase,
    E2eAdjudicationSpec,
    E2eAdjudication,
    E2eAffectedSpec,
    E2eAssessment,
} from './schema.js'

// --- Seed-time DAG integrity (run create first batch + debug pass-N append) ---
export {seedTaskRows, assertAcyclic} from './seed.js'
export type {SeedableTask, SeedContext} from './seed.js'

// --- Derive-don't-store gate-verdict accessors ---
export {
    deriveGateVerdict,
    deriveAllGatesVerdict,
    derivePanelVerdict,
    deriveMergeGateVerdict,
    mergeGateBlockReason,
} from './derive.js'
export type {GateId, EvidenceGate, GateEvidence, GateVerdict} from './derive.js'

// --- StateManager + path helpers ---
export {
    StateManager,
    type StateManagerOptions,
    type CreateRunArgs,
    type LockTuning,
    type StaleRunDir,
} from './manager.js'

export {
    SPECS_DIR,
    RUNS_DIR,
    CURRENT_LINK,
    CURRENT_DIR,
    STATE_FILE,
    repoKey,
    runsRoot,
    runDir,
    runStatePath,
    runCoverageDir,
    currentRepoRoot,
    currentRepoLinkPath,
    specsRoot,
    specDir,
} from './paths.js'
