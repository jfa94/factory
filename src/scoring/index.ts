/**
 * `src/scoring` — WS12 public barrel: run scoring/summary, the deterministic
 * partial-run report, and the telemetry sink. Consumers import the run-outcome
 * surfaces from here.
 */

export {
    buildPartialReport,
    renderPartialReportMarkdown,
    renderFailureComment,
    failureCommentMarker,
    selfHealCommentMarker,
} from './partial-report.js'
export type {
    PartialRunReport,
    ShippedLine,
    FailureLine,
    IncompleteLine,
    BuildPartialReportOptions,
} from './partial-report.js'

export {buildRunSummary, renderRunSummaryMarkdown} from './summary.js'
export type {RunSummary, RunEffort, ShippedPr, BuildRunSummaryOptions} from './summary.js'

export {emitMetric, readMetrics, recordRunFinalized} from './telemetry.js'
export type {MetricRecord, EmitOptions} from './telemetry.js'
