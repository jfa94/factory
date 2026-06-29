/**
 * `src/verifier/holdout` — the Δ Y holdout gate (Decision 5). The ONE addressable
 * import surface for WS10 (the orchestrator) and any downstream consumer.
 *
 * Split (pure) → answer-key store (confined) → agent validation + deterministic
 * score → a {@link GateEvidence} recorded into the risk-invariant merge gate. Deep-
 * importing `src/verifier/holdout/*` is a smell; import here.
 */

// The deterministic criteria split.
export { splitHoldout, holdoutCount, type HoldoutSplit } from "./split.js";

// The answer-key store (runs/<run>/holdouts/<task>.json — Δ Y confined subtree).
export {
  HoldoutRecordSchema,
  parseHoldoutRecord,
  makeHoldoutRecord,
  InMemoryHoldoutStore,
  FsHoldoutStore,
  type HoldoutRecord,
  type HoldoutStore,
} from "./store.js";

// Agent validation + deterministic scoring → gate evidence.
export {
  buildHoldoutPrompt,
  parseHoldoutVerdicts,
  checkHoldout,
  holdoutEvidence,
  deriveHoldoutEvidence,
  type HoldoutVerdict,
  type HoldoutCriterionResult,
  type HoldoutCheckResult,
  type HoldoutValidateInput,
  type HoldoutValidatorRunner,
} from "./validate.js";

// The holdout-VERDICT store (the orchestrator's holdout → review record hand-off).
export {
  InMemoryHoldoutVerdictStore,
  FsHoldoutVerdictStore,
  type HoldoutVerdictStore,
} from "./verdict-store.js";

// Exported fakes for downstream + own unit tests.
export { FakeHoldoutValidatorRunner, type FakeHoldoutMode } from "./fakes.js";
