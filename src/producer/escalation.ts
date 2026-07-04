/**
 * The producer escalation cap (Decision 25).
 *
 * The bounded nuke-and-retry ladder is NOT a producer-module function anymore: the
 * orchestrator re-expresses it via the persisted `escalation_rung` (see
 * `src/orchestrator/transitions.ts`), capped at this constant. Each rung "changes a
 * variable" — the combined model→effort dial (`src/producer/model-dial.ts`) climbs
 * the model to its ceiling then climbs effort, and rung ≥1 injects fresh /
 * prior-failure context. When the cap is reached with the merge gate still blocked, the
 * task is a LOUD classified failure (`capability-budget`).
 *
 * Cap = 4 ⇒ 5 total attempts per task (rung 0 + 4 escalating retries). This budget
 * is SHARED across producer failures AND reviewer send-backs (the rung is a single
 * counter). Raising it from 2 gives hard tasks the full model→effort climb before a
 * failure (see `jfa94/outsidey#231`).
 */

/** The maximum number of escalating producer retries past the starting rung. */
export const ESCALATION_CAP = 4
