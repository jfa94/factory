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

export { emitMetric, readMetrics, recordRunFinalized } from "./telemetry.js";
export type { MetricRecord, EmitOptions } from "./telemetry.js";
