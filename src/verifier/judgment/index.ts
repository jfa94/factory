/**
 * WS7 — judgment-verifier barrel. The risk-invariant panel + deterministic
 * citation-verify + verify-then-fix (Decision 26/27, Δ K/T/U).
 *
 * Re-exports WS7's own surface ONLY. It does NOT touch `src/types` (the frozen
 * cross-domain barrel) — WS7 imports the seams FROM there but adds nothing to it.
 */

// config resolution
export {
  FALLBACK_REVIEW_MODEL,
  resolveReviewModel,
  resolveJudgmentConfig,
  type JudgmentConfig,
} from "./config.js";

// risk-invariant panel
export { PANEL_ROLES, buildPanelManifest } from "./panel.js";

// cross-vendor slot (loud-when-absent)
export {
  resolveCrossVendor,
  type VendorProbe,
  type CrossVendorSlot,
  type CrossVendorResolution,
} from "./vendor.js";
export {
  CODEX_PROBE_TIMEOUT_MS,
  makeCodexProbe,
  codexProbe,
  resolveCodexCrossVendor,
  type ProbeExec,
} from "./codex-probe.js";

// judgment-domain finding types
export {
  FindingSeverityEnum,
  FindingSchema,
  RawReviewVerdictEnum,
  RawReviewSchema,
  parseRawReview,
  parseFinding,
  isCitable,
  type Finding,
  type FindingSeverity,
  type RawReview,
  type RawReviewVerdict,
} from "./finding.js";

// deterministic citation-verify
export {
  CITATION_WINDOW,
  verifyCitations,
  type SourceReader,
  type FailReason,
  type DroppedFinding,
  type KeptFinding,
  type CitationVerifyResult,
  type VerifyCitationsOptions,
} from "./citation-verify.js";

// verify-then-fix independent finding-verifier
export {
  confirmBlocker,
  type ClaimOnlyFinding,
  type FindingVerifierRunner,
  type VerifierVerdict,
  type VerifierOutcome,
  type VerifierEvidence,
} from "./finding-verifier.js";

// end-to-end verify pass (derive-don't-store merge gate)
export {
  runPanel,
  spawnPanel,
  type RunPanelInput,
  type PanelRunResult,
  type AdjudicatedReviewer,
} from "./panel-run.js";
