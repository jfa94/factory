/**
 * Phase literal tuples — the foundational leaf for the phase-name vocabulary.
 *
 * A zero-import leaf (no imports at all, mirrors {@link ./tcb.ts}) so it can be
 * imported DOWN by any layer without creating a cycle:
 *   - `core/state/schema.ts` (Zod enums for TaskState.phase + spawn_in_flight.phase)
 *   - `core/phase-machine/phases.ts` (TaskPhaseEnum, TASK_PHASE_ORDER)
 *   - `src/orchestrator/results.ts` (SPAWN_PHASES, SpawnPhase)
 *
 * Cross-check test in `src/orchestrator/orchestrator.test.ts` pins these tuples
 * equal to their consumers' runtime values — keep that test alive.
 *
 * Do NOT re-export through `src/types/index.ts`: the barrel already re-exports
 * TaskPhaseEnum / TaskPhase / TASK_PHASE_ORDER via core/phase-machine and would
 * create a cycle (types/index.ts → core/state → types/phases-vocab → (nothing) is
 * safe; types/index.ts → types/phases-vocab (re-export) is unnecessary).
 */

/** All per-task phases in execution order. */
export const TASK_PHASES = ["preflight", "tests", "exec", "verify", "ship"] as const;
export type TaskPhaseLiteral = (typeof TASK_PHASES)[number];

/**
 * The subset of task phases that can appear in a spawn envelope (preflight only
 * advances; ship never spawns).
 */
export const SPAWN_PHASES = ["tests", "exec", "verify"] as const;
export type SpawnPhaseLiteral = (typeof SPAWN_PHASES)[number];
