/**
 * The producer escalation cap (Decision 25, Δ cap = 2).
 *
 * The bounded nuke-and-retry ladder is NOT a producer-module function anymore: the
 * driver re-expresses it via the persisted `escalation_rung` (see
 * `src/driver/transitions.ts`), capped at this constant. Each rung "changes a
 * variable" (the dialed model and/or injected prior-failure context); when the cap
 * is reached with the floor still blocked, the task is a LOUD classified drop.
 */

/** The maximum number of escalating producer retries past the starting rung. */
export const ESCALATION_CAP = 2;
