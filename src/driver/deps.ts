/**
 * WS10 — the driver's INTERNAL import barrel.
 *
 * The driver is the integration capstone: it wires SEVEN domains (state, stage-
 * machine, git, quota, spec, deterministic + judgment verifiers, producer). Rather
 * than scatter deep imports across handlers.ts / coroutine.ts / fold.ts, this
 * one module re-exports exactly the symbols the driver consumes, each FROM its
 * sanctioned public barrel (src/types for the frozen seams; the per-domain
 * index.ts otherwise) — never a deep `src/<domain>/<file>` import. Mirrors the
 * "addressable from one place" discipline the seam barrels themselves follow.
 */

// --- frozen cross-domain seams (src/types) ----------------------------------
export {
  advance,
  spawn,
  gracefulStop,
  waitRetry,
  taskDone,
  taskDropped,
  finalizeTerminal,
  assertNever,
  isTerminalResult,
  runStage,
  nextStageFor,
  decideFinalize,
  nextStage,
  stageToInFlightStatus,
  TASK_STAGE_ORDER,
  parseSpawnManifest,
  TERMINAL_RUN_STATUSES,
  isTerminalTaskStatus,
  isTerminalRunStatus,
  PanelVerdictEnum,
  TaskStatusEnum,
  derivePanelVerdict,
  deriveAllGatesVerdict,
  deriveFloorVerdict,
  StateManager,
} from "../types/index.js";
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
  StageResult,
  StageContext,
  StageHandlers,
  SpawnManifest,
  SpawnAgent,
  SpawnRole,
  TaskStage,
} from "../types/index.js";

// --- git / PR I/O (src/git) -------------------------------------------------
export {
  createTaskWorktree,
  assertBaseIsStagingTip,
  ensureOnStaging,
  removeWorktree,
  createTaskPrIdempotent,
  MergeSerializer,
  probeProtection,
  requireProtectionOrRefuse,
  provisionProtection,
  runScopedBranch,
  ensureStaging,
  rollup,
} from "../git/index.js";
export type {
  GitClient,
  GhClient,
  TaskWorktree,
  CreateTaskWorktreeArgs,
  CreateTaskPrArgs,
  TaskPrResult,
  MergeOutcome,
  ProtectionState,
  RollupResult,
  RollupArgs,
} from "../git/index.js";

// --- run scoring / report / telemetry (src/scoring) — WS12 ------------------
export {
  buildPartialReport,
  renderPartialReportMarkdown,
  renderFailureIssue,
  recordRunFinalized,
} from "../scoring/index.js";
export type { PartialRunReport, FailureLine } from "../scoring/index.js";

// --- quota pacing (src/quota) -----------------------------------------------
export {
  evaluate as evaluateQuota,
  decisionToStageResult,
  buildCheckpoint,
  clearCheckpoint,
  selectProducerModel,
} from "../quota/index.js";
export type { QuotaDecision, UsageSignal, UsageReading } from "../quota/index.js";

// --- spec store (src/spec) --------------------------------------------------
export { SpecStore, makeSpecId } from "../spec/index.js";
export type { SpecManifest, SpecTask } from "../spec/index.js";

// --- producer ladder (src/producer) -----------------------------------------
export {
  dialForRung,
  buildProducerContext,
  classifyFailure,
  ESCALATION_CAP,
  parseProducerStatus,
} from "../producer/index.js";
export type {
  ProducerAgentRunner,
  ProducerSpawn,
  ProducerOutcome,
  ProducerRole,
  ProducerContext,
  DialResult,
  PriorFailureNote,
  FailureSignal,
  ClassifyDecision,
} from "../producer/index.js";

// --- deterministic verifier (src/verifier/deterministic) --------------------
export { GateRunner, GateMemo } from "../verifier/deterministic/index.js";
export type {
  GateContext,
  GateRunResult,
  GateReportEntry,
  GateTools,
} from "../verifier/deterministic/index.js";

// --- judgment verifier (src/verifier/judgment) ------------------------------
export {
  runPanel,
  PANEL_ROLES,
  buildPanelManifest,
  resolveReviewModel,
  resolveJudgmentConfig,
  parseRawReview,
} from "../verifier/judgment/index.js";
export type {
  RunPanelInput,
  PanelRunResult,
  RawReview,
  Finding,
  SourceReader,
  FindingVerifierRunner,
  JudgmentConfig,
} from "../verifier/judgment/index.js";

// --- holdout floor (src/verifier/holdout) — Δ Y ------------------------------
export {
  splitHoldout,
  makeHoldoutRecord,
  checkHoldout,
  holdoutEvidence,
  buildHoldoutPrompt,
  parseHoldoutVerdicts,
  InMemoryHoldoutStore,
  FsHoldoutStore,
} from "../verifier/holdout/index.js";
export type {
  HoldoutStore,
  HoldoutRecord,
  HoldoutSplit,
  HoldoutVerdict,
  HoldoutCheckResult,
  HoldoutValidateInput,
  HoldoutValidatorRunner,
} from "../verifier/holdout/index.js";
