/**
 * `src/producer` — WS8 public surface (Decision 22/25/27, Δ D). The ONE
 * addressable WS8 import surface for WS10 (the in-session runner) and any other
 * downstream consumer. Deep-importing `src/producer/*` is a smell; import here.
 *
 * WS8 imports the frozen seams FROM `src/types` (PhaseResult constructors,
 * enums, Config), the WS4 dial (selectProducerModel via src/quota), and the WS7
 * judgment surface (Finding); it adds NOTHING to those barrels.
 */

// Injectable producer-agent boundary + outcome parse.
export {
  parseProducerStatus,
  type ProducerAgentRunner,
  type ProducerSpawn,
  type ProducerOutcome,
  type ProducerRole,
} from "./agents.js";

// The model dial + escalation derivation (the "change a variable" source).
export { dialForRung, type DialResult } from "./model-dial.js";

// Structured producer prompt-context assembly (holdout-safe).
export {
  buildProducerContext,
  type BuildProducerContextInput,
  type ProducerContext,
  type FixInstruction,
  type PriorFailureNote,
  type ConfirmedBlocker,
} from "./prompt-context.js";

// Classify-before-retry (Δ D).
export { classifyFailure, type FailureSignal, type ClassifyDecision } from "./classify.js";

// The escalation cap. The bounded nuke-and-retry ladder is re-expressed by the
// orchestrator via the persisted `escalation_rung` (src/orchestrator/transitions.ts), capped here.
export { ESCALATION_CAP } from "./escalation.js";
