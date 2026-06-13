/**
 * WS6 — coverage gate strategy (per-layer coverage delta, Δ O).
 *
 * Ported from bin/pipeline-coverage-gate. Compares before/after coverage-v8 total
 * summaries; computes per-metric delta rounded to 2 decimal places; FAILS if any
 * of {lines, branches, functions, statements} decreased by MORE than the
 * configured tolerance (`quality.coverageRegressionTolerancePct`, default 0.5).
 *
 * Applicability (Δ skip): when BOTH summaries are ABSENT the project never captured
 * coverage, so the gate is NOT APPLICABLE (skip "no-coverage-data", excluded from
 * the conjunction) — it must not fail-close a clean repo that never opted in. A
 * present-but-INVALID summary, or an asymmetric one-absent reading, is a real
 * anomaly ⇒ fail-closed (bash rc=2 → observed:false). "Nothing to compare" is never
 * a pass; "nothing was ever measured" is a skip, not a fail.
 */
import type { GateOutcome, GateStrategy, StrategyContext } from "../strategy.js";
import { ran, skip } from "../strategy.js";
import type { CoverageSummary, GateTools } from "../tools.js";

const METRICS = ["lines", "branches", "functions", "statements"] as const;
type Metric = (typeof METRICS)[number];

/** Round to 2 decimal places, mirroring jq `(x*100|round)/100`. */
export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Per-metric delta (after - before), each rounded to 2dp. */
export function coverageDelta(
  before: CoverageSummary,
  after: CoverageSummary,
): Record<Metric, number> {
  return {
    lines: round2(after.lines - before.lines),
    branches: round2(after.branches - before.branches),
    functions: round2(after.functions - before.functions),
    statements: round2(after.statements - before.statements),
  };
}

/**
 * Metrics that decreased beyond tolerance. A metric fails when its delta is
 * STRICTLY LESS than `-tolerance` (bin/pipeline-coverage-gate:90-92: `$d.x < (-1*$t)`).
 */
export function regressions(delta: Record<Metric, number>, tolerance: number): Metric[] {
  const threshold = -1 * tolerance;
  return METRICS.filter((m) => delta[m] < threshold);
}

export const coverageStrategy: GateStrategy<GateTools> = {
  id: "coverage",
  async run(ctx: StrategyContext<GateTools>): Promise<GateOutcome> {
    const tolerance = ctx.config.quality.coverageRegressionTolerancePct;
    const opts = { cwd: ctx.worktree };
    const before = await ctx.tools.coverage.read("before", opts);
    const after = await ctx.tools.coverage.read("after", opts);
    // BOTH absent ⇒ the project never captured coverage ⇒ NOT APPLICABLE (skip,
    // excluded from the conjunction). Never fail-close a repo that never opted in.
    if (before.state === "absent" && after.state === "absent") {
      return skip("coverage", "no-coverage-data");
    }
    // A present-but-corrupt summary is a real anomaly ⇒ fail-closed (bash exit 2).
    if (before.state === "invalid" || after.state === "invalid") {
      const which = before.state === "invalid" ? "before" : "after";
      return ran("coverage", false, `coverage parse error: ${which} summary invalid`);
    }
    // Exactly one absent (the other valid) ⇒ a capture failed ⇒ fail-closed; we
    // cannot compute a delta, and "half a measurement" is never a pass.
    if (before.state === "absent" || after.state === "absent") {
      const which = before.state === "absent" ? "before" : "after";
      return ran("coverage", false, `coverage parse error: ${which} summary missing`);
    }
    const delta = coverageDelta(before.summary, after.summary);
    const failed = regressions(delta, tolerance);
    if (failed.length > 0) {
      const named = failed.map((m) => `${m} (${delta[m]}%)`).join(", ");
      return ran("coverage", false, `coverage decreased beyond ${tolerance}%: ${named}`);
    }
    return ran("coverage", true, `coverage within tolerance ${tolerance}%`);
  },
};
