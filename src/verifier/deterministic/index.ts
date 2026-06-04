/**
 * WS6 — deterministic-verifier (gates) barrel. ONE GateRunner + per-gate
 * strategies, injectable tools + fakes, the clean-checkout gate-of-record, and the
 * memo. Downstream (WS8 producer, WS10 driver, the verify handler) imports ONLY
 * from here.
 *
 * It re-exports WS6's own surface; it imports the frozen seams (GateEvidence /
 * GateVerdict / deriveAllGatesVerdict) FROM src/types and adds nothing to that
 * barrel.
 */

// strategy seam + closed gate union
export {
  GATE_IDS,
  ran,
  skip,
  type GateId,
  type GateRan,
  type GateSkip,
  type GateOutcome,
  type GateStrategy,
  type StrategyContext,
} from "./strategy.js";

// the runner + derived verdict
export {
  GateRunner,
  strategyFor,
  type GateContext,
  type GateRunResult,
  type GateReportEntry,
} from "./gate-runner.js";

// per-gate strategies
export { testStrategy } from "./strategies/test.js";
export { tddStrategy } from "./strategies/tdd.js";
export { coverageStrategy } from "./strategies/coverage.js";
export { mutationStrategy } from "./strategies/mutation.js";
export { sastStrategy } from "./strategies/sast.js";
export { typeStrategy } from "./strategies/type.js";
export { lintStrategy } from "./strategies/lint.js";
export { buildStrategy } from "./strategies/build.js";

// strategy math (pure, exported for reuse + parity vectors)
export { round2, coverageDelta, regressions } from "./strategies/coverage.js";
export { scorePasses } from "./strategies/mutation.js";
export { validateSecurityCommand, type CommandValidation } from "./strategies/sast.js";
export { isSquashedHistory } from "./strategies/tdd.js";

// testing-scope matrix (Δ O)
export {
  isTestPath,
  isDocsPath,
  isMutableSrc,
  mutationScope,
  diffScopedTestFiles,
} from "./scope.js";

// TDD classification (Δ N)
export {
  classifyCommit,
  deriveTddVerdict,
  type CommitKind,
  type TddVerdict,
  type TddViolation,
  type TddViolationReason,
} from "./tdd-classify.js";

// tdd_exempt resolution
export {
  isTddExempt,
  DefaultExemptReader,
  type ExemptReader,
  type DefaultExemptReaderArgs,
} from "./tdd-exempt.js";

// memoization (Δ N/O)
export { GateMemo } from "./memo.js";

// gate-of-record (Δ Z)
export { runGatesInCleanCheckout, type CleanCheckoutArgs } from "./clean-checkout.js";

// injectable tool interfaces + default impls
export {
  DefaultGitProbe,
  DefaultVitestTool,
  DefaultTscTool,
  DefaultEslintTool,
  DefaultBuildTool,
  DefaultSemgrepTool,
  DefaultStrykerTool,
  DefaultCoverageReader,
  parseCoverageSummary,
  type GateTools,
  type GitProbe,
  type CommitInfo,
  type ToolRunOpts,
  type ProcResult,
  type VitestTool,
  type TscTool,
  type EslintTool,
  type BuildTool,
  type SemgrepTool,
  type StrykerTool,
  type StrykerResult,
  type CoverageReader,
  type CoverageSummary,
} from "./tools.js";

// exported fakes for downstream unit tests
export {
  proc,
  strykerResult,
  commit,
  makeFakeTools,
  FakeVitest,
  FakeTsc,
  FakeEslint,
  FakeBuild,
  FakeSemgrep,
  FakeStryker,
  FakeCoverageReader,
  FakeGitProbe,
  type FakeGitProbeOptions,
  type FakeToolsOptions,
} from "./fakes.js";
