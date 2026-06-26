/**
 * `src/core/phase-machine` — the FROZEN WS2 seam. The PURE per-task phase engine,
 * its discriminated-union result contract, the Zod spawn manifest, the phase
 * vocabulary, and the injectable handler interface. Re-exported via `src/types`.
 *
 * Imports the WS1 state seam (RunState/TaskState/enums) — never redefines it.
 */

// --- Phase vocabulary ---
export {
  TaskPhaseEnum,
  RunPhaseEnum,
  TASK_PHASE_ORDER,
  nextPhase,
  phaseToInFlightStatus,
} from "./phases.js";
export type { TaskPhase, RunPhase } from "./phases.js";

// --- Spawn manifest (Zod) ---
export {
  SpawnRoleEnum,
  SpawnAgentSchema,
  SpawnManifestSchema,
  parseSpawnManifest,
} from "./manifest.js";
export type { SpawnRole, SpawnAgent, SpawnManifest } from "./manifest.js";

// --- PhaseResult union + constructors + primitives ---
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
  PhaseResult,
  AdvanceResult,
  SpawnAgentsResult,
  GracefulStopResult,
  WaitRetryResult,
  TaskTerminalResult,
  FinalizeTerminalResult,
} from "./result.js";

// --- Handler contract (the fakeable seam) ---
export type { PhaseContext, PhaseHandlers } from "./handlers.js";

// --- The engine ---
export { runPhase, nextPhaseFor, decideFinalize } from "./engine.js";
export type { EnginePhase } from "./engine.js";
