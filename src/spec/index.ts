/**
 * `src/spec` — WS5 public surface. The ONE addressable WS5 import surface for
 * WS10 (the in-session driver) and any other downstream consumer. Deep-importing
 * `src/spec/*` is a smell; import from here.
 *
 * Re-exports: the durable spec schema (SpecTask/SpecManifest + parsers), the
 * injectable GhClient (interface + real impl + typed errors), the SpecStore, the
 * apex-pinned SpecAgentRunner boundary + spawn builders, the three deterministic
 * gates, the review adjudication (single 56/60 threshold + floor), and the shared
 * durable-manifest builder.
 */

// Durable on-disk spec artifact.
export {
  SpecTaskSchema,
  SpecTasksSchema,
  SpecManifestSchema,
  parseSpecTasks,
  parseSpecManifest,
  type SpecTask,
  type SpecManifest,
} from "./schema.js";

// PRD fetch (injectable gh wrapper).
export {
  RealGhClient,
  GhAuthError,
  IssueNotFoundError,
  type GhClient,
  type Prd,
  type ExecFn,
} from "./gh.js";

// Durable spec store (Δ X reuse-by-issue).
export { SpecStore, makeSpecId } from "./store.js";

// Apex-pinned spec-agent boundary (Decision 21).
export {
  buildGenerateSpawn,
  buildReviewSpawn,
  GenerateResultSchema,
  parseGenerateResult,
  type SpecAgentRunner,
  type SpecAgentRole,
  type SpecSpawnSpec,
  type GenerateResult,
} from "./agents.js";

// Deterministic spec gates.
export {
  verticalSliceGate,
  testabilityGate,
  traceabilityGate,
  runSpecGates,
  combineGates,
  extractPrdRequirements,
  type GateResult,
} from "./gates.js";

// Review adjudication (single 56/60 threshold + floor, Δ I) + rubric constants.
export {
  parseReviewVerdict,
  decideSpecReview,
  ReviewVerdictSchema,
  PerDimensionSchema,
  REVIEW_DIMENSION_COUNT,
  REVIEW_MAX_TOTAL,
  type ReviewVerdict,
  type PerDimension,
  type SpecReviewResult,
  type SpecReviewDecision,
  type DecideOptions,
} from "./review.js";

// Durable spec-manifest builder (shared by the `spec store` CLI seam).
export { buildManifest } from "./pipeline.js";

// Spec-pipeline defaults now live in the canonical config schema (src/config).
export { SPEC_DEFAULTS, type SpecConfig } from "../config/index.js";
