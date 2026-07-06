/**
 * `src/core/phase-machine` — the FROZEN WS2 seam. The PURE per-task phase engine,
 * its discriminated-union result contract, the Zod spawn request, the phase
 * vocabulary, and the injectable handler interface. Re-exported via `src/types`.
 *
 * Imports the WS1 state seam (RunState/TaskState/enums) — never redefines it.
 */

// --- Phase vocabulary ---
export {TaskPhaseEnum, RunPhaseEnum, TASK_PHASE_ORDER, nextPhase, phaseToInFlightStatus} from './phases.js'
export type {TaskPhase, RunPhase} from './phases.js'

// --- Spawn request (Zod) + the role→agent_type mapping home (C4) ---
export {
    SpawnRoleEnum,
    AgentSpecSchema,
    SpawnRequestSchema,
    parseSpawnRequest,
    AGENT_TYPE_BY_ROLE,
    GENERAL_PURPOSE_AGENT_TYPE,
    E2E_AUTHOR_AGENT_TYPE,
    E2E_ASSESSOR_AGENT_TYPE,
    TRACEABILITY_AUDITOR_AGENT_TYPE,
    SPEC_GENERATOR_AGENT_TYPE,
    SPEC_REVIEWER_AGENT_TYPE,
} from './spawn.js'
export type {SpawnRole, AgentSpec, SpawnRequest} from './spawn.js'

// --- PhaseResult union + constructors + primitives ---
export {
    assertNever,
    isTerminalResult,
    advance,
    spawn,
    gracefulStop,
    waitRetry,
    taskDone,
    taskFailed,
    finalizeTerminal,
} from './result.js'
export type {
    PhaseResult,
    AdvanceResult,
    SpawnAgentsResult,
    GracefulStopResult,
    WaitRetryResult,
    TaskTerminalResult,
    FinalizeTerminalResult,
} from './result.js'

// --- Handler contract (the fakeable seam) ---
export type {PhaseContext, PhaseHandlers} from './handlers.js'

// --- The engine ---
export {runPhase, nextPhaseFor, decideFinalize} from './engine.js'
export type {EnginePhase} from './engine.js'
