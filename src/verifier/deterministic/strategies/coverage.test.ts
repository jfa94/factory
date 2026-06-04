/**
 * WS6 — coverage gate vectors. Ports bin/pipeline-coverage-gate math: per-metric
 * delta rounded to 2dp, fail beyond tolerance with the offending metric named,
 * pass within tolerance, fail-closed on missing/invalid summary.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig, type Config } from "../../../config/schema.js";
import { FakeCoverageReader, makeFakeTools } from "../fakes.js";
import type { GateRan, StrategyContext } from "../strategy.js";
import type { CoverageSummary, GateTools } from "../tools.js";
import { coverageDelta, coverageStrategy, regressions, round2 } from "./coverage.js";

function ctx(tools: GateTools, config: Config = defaultConfig()): StrategyContext<GateTools> {
  return { runId: "r", taskId: "t", worktree: "/wt", baseRef: "staging", config, tools };
}

const full: CoverageSummary = { lines: 90, branches: 90, functions: 90, statements: 90 };

describe("coverage math", () => {
  it("round2 rounds to 2 decimal places", () => {
    expect(round2(1.234)).toBe(1.23);
    expect(round2(1.235)).toBe(1.24);
    // Tiny negatives round to (numeric) zero. jq's (x*100|round)/100 yields -0 too;
    // -0 === 0 and is never a regression, so assert numeric (not Object.is) equality.
    expect(round2(-0.001) === 0).toBe(true);
    expect(round2(89.999 - 90) === 0).toBe(true);
  });

  it("delta is after-before per metric", () => {
    const d = coverageDelta(full, { lines: 91, branches: 89, functions: 90, statements: 88 });
    expect(d).toEqual({ lines: 1, branches: -1, functions: 0, statements: -2 });
  });

  it("regressions are metrics below -tolerance (strict <)", () => {
    const d = { lines: -0.5, branches: -0.6, functions: 0, statements: -0.51 };
    // tolerance 0.5: -0.5 is NOT < -0.5 (boundary passes); -0.6 and -0.51 fail.
    expect(regressions(d, 0.5)).toEqual(["branches", "statements"]);
  });
});

describe("coverageStrategy", () => {
  it("any metric decreased beyond tolerance → FAIL naming the metric", async () => {
    const tools = makeFakeTools({
      coverage: new FakeCoverageReader({
        before: full,
        after: { lines: 90, branches: 88, functions: 90, statements: 90 },
      }),
    });
    const out = await coverageStrategy.run(ctx(tools));
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("branches");
  });

  it("within tolerance → PASS (boundary -0.5 at tolerance 0.5 passes)", async () => {
    const tools = makeFakeTools({
      coverage: new FakeCoverageReader({
        before: full,
        after: { lines: 89.5, branches: 90, functions: 90, statements: 90 },
      }),
    });
    const out = await coverageStrategy.run(ctx(tools));
    expect((out as GateRan).evidence.observed).toBe(true);
  });

  it("missing/invalid summary → fail-closed parse error", async () => {
    const tools = makeFakeTools({
      coverage: new FakeCoverageReader({ before: full, after: null }),
    });
    const out = await coverageStrategy.run(ctx(tools));
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("parse error");
  });

  it("config tolerance drives the threshold (no scattered literal)", async () => {
    const config = defaultConfig();
    config.quality.coverageRegressionTolerancePct = 5;
    const tools = makeFakeTools({
      coverage: new FakeCoverageReader({
        before: full,
        after: { lines: 86, branches: 90, functions: 90, statements: 90 }, // -4, within 5
      }),
    });
    const out = await coverageStrategy.run(ctx(tools, config));
    expect((out as GateRan).evidence.observed).toBe(true);
  });
});
