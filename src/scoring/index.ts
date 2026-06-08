/**
 * `src/scoring` — WS12 public barrel: run scoring/summary, the deterministic
 * partial-run report, dead-surface scan, and the telemetry sink. Consumers import
 * the run-outcome surfaces from here.
 */

export {
  buildPartialReport,
  renderPartialReportMarkdown,
  renderFailureIssue,
} from "./partial-report.js";
export type {
  PartialRunReport,
  ShippedLine,
  FailureLine,
  IncompleteLine,
  FailureIssue,
  BuildPartialReportOptions,
} from "./partial-report.js";

export { buildRunSummary, renderRunSummaryMarkdown } from "./summary.js";
export type { RunSummary, RunEffort, ShippedPr, BuildRunSummaryOptions } from "./summary.js";

export {
  scanDeadSurface,
  parseTsPruneOutput,
  scopeToChangedFiles,
  TsPruneRunner,
} from "./dead-surface.js";
export type {
  DeadSurfaceReport,
  DeadSurfaceFinding,
  DeadSurfaceStatus,
  DeadSurfaceRunner,
  DeadSurfaceRunResult,
} from "./dead-surface.js";

export { emitMetric, readMetrics, recordRunFinalized } from "./telemetry.js";
export type { MetricRecord, EmitOptions } from "./telemetry.js";
