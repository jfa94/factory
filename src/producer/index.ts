/**
 * `src/producer` — WS8 public surface (Decision 22/25/27, Δ D). The ONE
 * addressable WS8 import surface for WS10 (the in-session driver) and any other
 * downstream consumer. Deep-importing `src/producer/*` is a smell; import here.
 *
 * WS8 imports the frozen seams FROM `src/types` (StageResult constructors,
 * enums, Config), the WS4 dial (selectProducerModel via src/quota), and the WS7
 * judgment surface (rebuttal / finding); it adds NOTHING to those barrels.
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
} from "./prompt-context.js";

// Classify-before-retry (Δ D).
export { classifyFailure, type FailureSignal, type ClassifyDecision } from "./classify.js";

// Fix-forward inner loop (D27).
export {
  runFixForward,
  type FixForwardInput,
  type FixForwardResult,
  type RebuttalRequest,
} from "./fix-forward.js";

// The bounded nuke-and-retry OUTER loop — the escalation ladder entrypoint.
export {
  runLadder,
  assertRungChange,
  ESCALATION_CAP,
  type LadderTask,
  type LadderDeps,
  type VerifyPass,
  type VerifyPassResult,
} from "./ladder.js";

// Exported fakes for downstream + own unit tests.
export {
  FakeProducerAgentRunner,
  FakeRebuttalAdjudicator,
  FakeVendorProbe,
  makeFakeVerify,
  verifyBlocked,
  fakeFinding,
  VERIFY_CLEAR,
  VERIFY_ERROR,
} from "./fakes.js";
