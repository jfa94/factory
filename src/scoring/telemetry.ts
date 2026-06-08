/**
 * WS12 — the thin telemetry / metrics sink (Decision: thin jsonl, #4; MCP/SQLite
 * server explicitly out of scope).
 *
 * One append-only `metrics.jsonl` per run under the run store. Each record is a
 * `{ ts, run_id, event, data? }` line. The sink is deliberately minimal: it is
 * observability, not load-bearing state (that lives in `state.json`, atomic). A
 * write failure here must never break a run, so {@link emitMetric} swallows IO
 * errors after logging them — losing a metric line is acceptable; aborting a
 * finalize because telemetry's disk is full is not.
 *
 * `dataDir` is the already-resolved plugin data dir (callers resolve via
 * `resolveDataDir`); paths go through the frozen `paths.ts` run-store helpers.
 */
import { appendJsonl, readJsonl, createLogger, nowIso } from "../shared/index.js";
import { runMetricsPath } from "../core/state/paths.js";
import type { PartialRunReport } from "./partial-report.js";

const log = createLogger("telemetry");

/** A single telemetry line. `event` is a dotted name; `data` is free-form. */
export interface MetricRecord {
  /** ISO-8601 emit time. */
  ts: string;
  /** The run this metric belongs to. */
  run_id: string;
  /** Dotted event name, e.g. "run.finalized", "task.dropped". */
  event: string;
  /** Optional structured payload. */
  data?: Record<string, unknown>;
}

/** Options shared by the emit helpers. */
export interface EmitOptions {
  /** Override the timestamp (tests pin this). Defaults to `nowIso()`. */
  now?: string;
}

/**
 * Append one metric line to the run's `metrics.jsonl`. Returns the record written
 * (useful for tests / chaining). IO failures are LOGGED and swallowed — a metric
 * is never worth failing a run over.
 */
export async function emitMetric(
  dataDir: string,
  runId: string,
  event: string,
  data?: Record<string, unknown>,
  opts: EmitOptions = {},
): Promise<MetricRecord> {
  const record: MetricRecord = {
    ts: opts.now ?? nowIso(),
    run_id: runId,
    event,
    ...(data !== undefined ? { data } : {}),
  };
  try {
    await appendJsonl(runMetricsPath(dataDir, runId), record);
  } catch (err) {
    log.warn(`failed to write metric '${event}' for ${runId}: ${(err as Error).message}`);
  }
  return record;
}

/** Read every metric line for a run (empty if none were emitted). */
export async function readMetrics(dataDir: string, runId: string): Promise<MetricRecord[]> {
  return readJsonl<MetricRecord>(runMetricsPath(dataDir, runId));
}

/**
 * Record the canonical run-finalized telemetry from a {@link PartialRunReport}:
 * one `run.finalized` line carrying the status + totals, then one `task.dropped`
 * line per failure (so a downstream aggregator can attribute drops to a failure
 * class without re-reading state). Shipped counts live in the totals — per-shipped
 * lines would be noise.
 */
export async function recordRunFinalized(
  dataDir: string,
  report: PartialRunReport,
  opts: EmitOptions = {},
): Promise<void> {
  const now = opts.now ?? nowIso();
  await emitMetric(
    dataDir,
    report.run_id,
    "run.finalized",
    {
      status: report.run_status,
      spec_id: report.spec_id,
      issue_number: report.issue_number,
      totals: report.totals,
    },
    { now },
  );
  for (const f of report.failures) {
    await emitMetric(
      dataDir,
      report.run_id,
      "task.dropped",
      { task_id: f.task_id, failure_class: f.failure_class },
      { now },
    );
  }
}
