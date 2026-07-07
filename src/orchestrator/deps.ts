/**
 * WS10 — the orchestrator's INTERNAL import barrel.
 *
 * The orchestrator is the integration capstone: it wires SEVEN domains (state, phase-
 * machine, git, quota, spec, deterministic + judgment verifiers, producer). Rather
 * than scatter deep imports across handlers.ts / orchestrator.ts / record.ts, this
 * one module re-exports exactly the symbols the orchestrator consumes, each FROM its
 * sanctioned public barrel (src/types for the frozen seams; the per-domain
 * index.ts otherwise) — never a deep `src/<domain>/<file>` import. Mirrors the
 * "addressable from one place" discipline the seam barrels themselves follow.
 */

// --- frozen cross-domain seams (src/types) ----------------------------------
export {
    advance,
    spawn,
    waitRetry,
    taskDone,
    taskFailed,
    assertNever,
    runPhase,
    nextPhaseFor,
    decideFinalize,
    nextPhase,
    phaseToInFlightStatus,
    TASK_PHASE_ORDER,
    parseSpawnRequest,
    AGENT_TYPE_BY_ROLE,
    GENERAL_PURPOSE_AGENT_TYPE,
    E2E_AUTHOR_AGENT_TYPE,
    E2E_ASSESSOR_AGENT_TYPE,
    TRACEABILITY_AUDITOR_AGENT_TYPE,
    TERMINAL_RUN_STATUSES,
    isTerminalTaskStatus,
    isTerminalRunStatus,
    derivePanelVerdict,
    deriveMergeGateVerdict,
    mergeGateBlockReason,
    StateManager,
    E2eSpecKindEnum,
    E2eManifestEntrySchema,
    E2eAffectedSpecSchema,
} from '../types/index.js'
export type {
    Config,
    RunState,
    TaskState,
    RunStatus,
    TaskStatus,
    RiskTier,
    FailureClass,
    PanelVerdict,
    ReviewerResult,
    SpecPointer,
    GateEvidence,
    GateVerdict,
    PhaseResult,
    PhaseContext,
    PhaseHandlers,
    SpawnRequest,
    AgentSpec,
    SpawnRole,
    TaskPhase,
    E2eSpecKind,
    E2eManifestEntry,
    E2ePhase,
    E2eAdjudicationSpec,
    E2eAdjudication,
    E2eAffectedSpec,
    E2eAssessment,
} from '../types/index.js'

// --- git / PR I/O (src/git) -------------------------------------------------
export {
    createTaskWorktree,
    provisionWorktree,
    removeWorktreeBestEffort,
    assertBaseIsStagingTip,
    resyncTaskBranchOntoStaging,
    createTaskPrIdempotent,
    MergeSerializer,
    provisionProtection,
    runScopedBranch,
    runStagingBranch,
    ensureStaging,
    rollup,
} from '../git/index.js'
export type {
    GitClient,
    GhClient,
    TaskWorktree,
    CreateTaskWorktreeArgs,
    ProvisionWorktreeFn,
    CreateTaskPrArgs,
    TaskPrResult,
    MergeOutcome,
    ProtectionState,
    RollupResult,
    RollupArgs,
} from '../git/index.js'

// --- run scoring / report / telemetry (src/scoring) — WS12 ------------------
export {
    buildPartialReport,
    renderPartialReportMarkdown,
    renderFailureComment,
    failureCommentMarker,
    selfHealCommentMarker,
    recordRunFinalized,
} from '../scoring/index.js'
export type {PartialRunReport, FailureLine} from '../scoring/index.js'

// --- quota pacing (src/quota) -----------------------------------------------
export {
    evaluate as evaluateQuota,
    buildCheckpoint,
    buildUnavailableCheckpoint,
    clearCheckpoint,
} from '../quota/index.js'
export type {QuotaDecision, UsageSignal, UsageReading} from '../quota/index.js'

// --- spec store (src/spec) --------------------------------------------------
export {SpecStore} from '../spec/index.js'
export type {SpecManifest, SpecTask} from '../spec/index.js'

// --- producer ladder (src/producer) -----------------------------------------
export {
    dialForRung,
    buildProducerContext,
    classifyFailure,
    ESCALATION_CAP,
    parseProducerStatus,
} from '../producer/index.js'
export type {
    ProducerAgentRunner,
    ProducerSpawn,
    ProducerOutcome,
    ProducerRole,
    ProducerContext,
    DialResult,
    PriorFailureNote,
    ConfirmedBlocker,
    FailureSignal,
    ClassifyDecision,
} from '../producer/index.js'

// --- deterministic verifier (src/verifier/deterministic) --------------------
export {GateRunner, loadGateContract, FsCoverageStore} from '../verifier/deterministic/index.js'
export type {GateContext, GateRunResult, GateReportEntry, GateTools} from '../verifier/deterministic/index.js'

// --- judgment verifier (src/verifier/judgment) ------------------------------
export {
    runPanel,
    PANEL_ROLES,
    panelRolesFor,
    touchesDatabase,
    buildPanelManifest,
    resolveReviewModel,
    parseRawReview,
    resolveCodexCrossVendor,
} from '../verifier/judgment/index.js'
export type {
    RunPanelInput,
    PanelRunResult,
    RawReview,
    Finding,
    SourceReader,
    FindingVerifierRunner,
    JudgmentConfig,
    VendorProbe,
    CrossVendorResolution,
} from '../verifier/judgment/index.js'

// --- holdout gate (src/verifier/holdout) — Δ Y ------------------------------
export {
    splitHoldout,
    makeHoldoutRecord,
    checkHoldout,
    holdoutEvidence,
    buildHoldoutPrompt,
    parseHoldoutVerdicts,
    InMemoryHoldoutStore,
    FsHoldoutStore,
} from '../verifier/holdout/index.js'
export type {
    HoldoutStore,
    HoldoutRecord,
    HoldoutSplit,
    HoldoutVerdict,
    HoldoutCheckResult,
    HoldoutValidateInput,
    HoldoutValidatorRunner,
} from '../verifier/holdout/index.js'

// --- e2e runner (src/verifier/e2e) — Decision 39 ----------------------------
export {runE2e, DefaultPlaywrightTool} from '../verifier/e2e/index.js'
export type {E2eRunOpts, E2eResults, E2eSpecResult, PlaywrightTool} from '../verifier/e2e/index.js'

// --- rescue reset primitive (src/rescue) — reused by the e2e reopen loop ----
export {resetTaskRow, scanRun, effectiveAutoResets} from '../rescue/index.js'
export type {ResetTaskRowOpts} from '../rescue/index.js'
