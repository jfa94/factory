/**
 * `src/core/stage-machine` — the FROZEN WS2 seam. The PURE per-task stage engine,
 * its discriminated-union result contract, the Zod spawn manifest, the stage
 * vocabulary, and the injectable handler interface. Re-exported via `src/types`.
 *
 * Imports the WS1 state seam (RunState/TaskState/enums) — never redefines it.
 */

// --- Stage vocabulary ---
export {
  TaskStageEnum,
  RunStageEnum,
  TASK_STAGE_ORDER,
  nextStage,
  stageToInFlightStatus,
} from "./stages.js";
export type { TaskStage, RunStage } from "./stages.js";

// --- Spawn manifest (Zod) ---
export {
  SpawnRoleEnum,
  SpawnAgentSchema,
  SpawnManifestSchema,
  parseSpawnManifest,
} from "./manifest.js";
export type { SpawnRole, SpawnAgent, SpawnManifest } from "./manifest.js";

// --- StageResult union + constructors + primitives ---
export {
  assertNever,
  isTerminalResult,
  advance,
  spawn,
  gracefulStop,
  waitRetry,
  taskDone,
  taskDropped,
  finalizeTerminal,
} from "./result.js";
export type {
  StageResult,
  AdvanceResult,
  SpawnAgentsResult,
  GracefulStopResult,
  WaitRetryResult,
  TaskTerminalResult,
  FinalizeTerminalResult,
} from "./result.js";

// --- Handler contract (the fakeable seam) ---
export type { StageContext, StageHandlers } from "./handlers.js";

// --- The engine ---
export { runStage, nextStageFor, decideFinalize, StageEngine } from "./engine.js";
export type { EngineStage } from "./engine.js";
