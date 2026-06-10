/**
 * Shared plumbing for the state-write subcommands (`advance` / `drop` /
 * `record-producer` / `record-reviews`).
 *
 * These subcommands are the ONLY sanctioned way the in-session orchestrator mutates
 * run state between single-steps (Model A): each folds an out-of-band agent outcome
 * (or an explicit transition) into the persisted task via the SHARED
 * {@link import("../driver/index.js").transitions} logic, then emits ONE
 * {@link TransitionEnvelope} naming the resulting {@link TaskStep}. The orchestrator
 * reads the step and either runs the next `factory run-task --stage <step.stage>` or
 * stops (a terminal `done`/`dropped`).
 *
 * @deprecated Implementation moved to `../driver/fold.js`. This module is a
 * compatibility re-export kept until the CLI shells are deleted in Phase 2.
 */
export { persistStepCursor, readJsonInput } from "../driver/fold.js";
export type { TransitionEnvelope } from "../driver/fold.js";
