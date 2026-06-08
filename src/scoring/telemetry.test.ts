import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitMetric, readMetrics, recordRunFinalized } from "./telemetry.js";
import { runMetricsPath, runsRoot } from "../core/state/paths.js";
import type { PartialRunReport } from "./partial-report.js";

let dataDir: string;
const RUN = "run-1";
const NOW = "2026-02-02T12:00:00.000Z";

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "telemetry-test-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("emitMetric / readMetrics", () => {
  it("appends a stamped record readable by readMetrics", async () => {
    await emitMetric(dataDir, RUN, "task.shipped", { task_id: "t1" }, { now: NOW });
    const metrics = await readMetrics(dataDir, RUN);
    expect(metrics).toEqual([
      { ts: NOW, run_id: RUN, event: "task.shipped", data: { task_id: "t1" } },
    ]);
  });

  it("omits the data key when no payload is given", async () => {
    const rec = await emitMetric(dataDir, RUN, "run.started", undefined, { now: NOW });
    expect(rec).toEqual({ ts: NOW, run_id: RUN, event: "run.started" });
    expect("data" in rec).toBe(false);
  });

  it("accumulates multiple metrics in emit order", async () => {
    await emitMetric(dataDir, RUN, "a", undefined, { now: NOW });
    await emitMetric(dataDir, RUN, "b", undefined, { now: NOW });
    expect((await readMetrics(dataDir, RUN)).map((m) => m.event)).toEqual(["a", "b"]);
  });

  it("returns [] when a run emitted no metrics", async () => {
    expect(await readMetrics(dataDir, RUN)).toEqual([]);
  });

  it("writes to the run-store metrics path", async () => {
    await emitMetric(dataDir, RUN, "x", undefined, { now: NOW });
    const metrics = await readMetrics(dataDir, RUN);
    expect(metrics).toHaveLength(1);
    expect(runMetricsPath(dataDir, RUN)).toContain(join("runs", RUN, "metrics.jsonl"));
  });

  it("swallows an IO failure rather than breaking the run", async () => {
    // Plant a FILE where the run dir should be so mkdir(runs/<run>) fails.
    await mkdir(runsRoot(dataDir), { recursive: true });
    await writeFile(join(runsRoot(dataDir), RUN), "blocker", "utf8");

    // Must not throw despite the unwritable path.
    const rec = await emitMetric(dataDir, RUN, "task.dropped", { task_id: "t1" }, { now: NOW });
    expect(rec.event).toBe("task.dropped");
  });
});

describe("recordRunFinalized", () => {
  function report(overrides: Partial<PartialRunReport> = {}): PartialRunReport {
    return {
      run_id: RUN,
      run_status: "partial",
      spec_id: "42-checkout",
      issue_number: 42,
      repo: "acme/widgets",
      generated_at: NOW,
      totals: { total: 2, shipped: 1, failed: 1, incomplete: 0 },
      shipped: [{ task_id: "t1", title: "T1" }],
      failures: [
        {
          task_id: "t2",
          title: "T2",
          failure_class: "capability-budget",
          failure_reason: "exhausted",
          unmet_criteria: ["c1"],
        },
      ],
      incomplete: [],
      ...overrides,
    };
  }

  it("emits a run.finalized line plus one task.dropped per failure", async () => {
    await recordRunFinalized(dataDir, report(), { now: NOW });
    const metrics = await readMetrics(dataDir, RUN);

    expect(metrics.map((m) => m.event)).toEqual(["run.finalized", "task.dropped"]);
    expect(metrics[0]!.data).toMatchObject({
      status: "partial",
      totals: { total: 2, shipped: 1, failed: 1, incomplete: 0 },
    });
    expect(metrics[1]!.data).toEqual({ task_id: "t2", failure_class: "capability-budget" });
  });

  it("emits only run.finalized for a completed run with no failures", async () => {
    await recordRunFinalized(
      dataDir,
      report({
        run_status: "completed",
        totals: { total: 1, shipped: 1, failed: 0, incomplete: 0 },
        failures: [],
      }),
      { now: NOW },
    );
    const metrics = await readMetrics(dataDir, RUN);
    expect(metrics.map((m) => m.event)).toEqual(["run.finalized"]);
  });
});
