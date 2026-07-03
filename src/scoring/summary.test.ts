/**
 * WS12 — run SUMMARY (Decision 22, Δ S).
 *
 * `buildRunSummary` is pure over (run, report, now): these tests build run states
 * via {@link parseRunState} + craft {@link PartialRunReport} literals, and assert:
 *   - failures_by_class has a STABLE shape (every closed class present, 0 when none);
 *   - effort sums reviewer results across tasks + takes the max escalation rung;
 *   - shipped_prs mirrors the report's shipped lines (PR pointers preserved/omitted);
 *   - duration is whole seconds, or null when ended_at is absent / unparseable / < 0;
 *   - the markdown render is a compact headline (fails line only when there are fails).
 */
import { describe, it, expect } from "vitest";
import { buildRunSummary, renderRunSummaryMarkdown } from "./summary.js";
import type { PartialRunReport } from "./partial-report.js";
import { parseRunState, isTerminalRunStatus } from "../core/state/index.js";
import type { RunState, RunStatus, TaskState } from "../types/index.js";

type TaskSeed = Partial<TaskState> & { task_id: string; status: TaskState["status"] };

function task(seed: TaskSeed): TaskState {
  const base = {
    depends_on: [],
    risk_tier: "medium" as const,
    escalation_rung: 0,
    reviewers: [],
    merge_resyncs: 0,
    ...seed,
  };
  if (seed.status === "failed") {
    return { failure_class: "capability-budget" as const, failure_reason: "x", ...base };
  }
  return base;
}

function mkRun(
  seeds: readonly TaskSeed[],
  opts: { status?: RunStatus; started_at?: string; ended_at?: string | null } = {},
): RunState {
  const status = opts.status ?? "failed";
  return parseRunState({
    run_id: "run-sum-1",
    status,
    execution_mode: "balanced",
    spec: { repo: "acme/widgets", spec_id: "7-x", issue_number: 7 },
    tasks: Object.fromEntries(seeds.map((s) => [s.task_id, task(s)])),
    started_at: opts.started_at ?? "2026-06-08T00:00:00.000Z",
    ...(opts.ended_at !== undefined
      ? { ended_at: opts.ended_at }
      : isTerminalRunStatus(status)
        ? { ended_at: "2026-06-08T01:00:00.000Z" }
        : {}),
    updated_at: "2026-06-08T00:00:00.000Z",
  });
}

/** A minimal valid PartialRunReport, overridable per test. */
function report(over: Partial<PartialRunReport> = {}): PartialRunReport {
  return {
    run_id: "run-sum-1",
    run_status: "failed",
    spec_id: "7-x",
    issue_number: 7,
    repo: "acme/widgets",
    generated_at: "2026-06-08T01:00:00.000Z",
    totals: { total: 0, shipped: 0, failed: 0, incomplete: 0 },
    shipped: [],
    failures: [],
    incomplete: [],
    ...over,
  };
}

const NOW = "2026-06-08T02:00:00.000Z";

describe("buildRunSummary — failures_by_class shape", () => {
  it("seeds every closed failure class to 0 when there are no fails", () => {
    const summary = buildRunSummary(mkRun([{ task_id: "a", status: "done" }]), report(), {
      now: NOW,
    });
    expect(summary.failures_by_class).toEqual({
      "capability-budget": 0,
      "spec-defect": 0,
      "blocked-environmental": 0,
    });
  });

  it("tallies fails per class from the report", () => {
    const summary = buildRunSummary(
      mkRun([
        { task_id: "a", status: "failed", failure_class: "spec-defect" },
        { task_id: "b", status: "failed", failure_class: "spec-defect" },
        { task_id: "c", status: "failed", failure_class: "capability-budget" },
      ]),
      report({
        failures: [
          {
            task_id: "a",
            title: "A",
            failure_class: "spec-defect",
            failure_reason: "x",
            unmet_criteria: [],
          },
          {
            task_id: "b",
            title: "B",
            failure_class: "spec-defect",
            failure_reason: "x",
            unmet_criteria: [],
          },
          {
            task_id: "c",
            title: "C",
            failure_class: "capability-budget",
            failure_reason: "x",
            unmet_criteria: [],
          },
        ],
        totals: { total: 3, shipped: 0, failed: 3, incomplete: 0 },
      }),
      { now: NOW },
    );
    expect(summary.failures_by_class).toEqual({
      "capability-budget": 1,
      "spec-defect": 2,
      "blocked-environmental": 0,
    });
  });
});

describe("buildRunSummary — effort", () => {
  it("sums reviewer results across tasks and takes the max escalation rung", () => {
    const summary = buildRunSummary(
      mkRun([
        {
          task_id: "a",
          status: "done",
          escalation_rung: 1,
          reviewers: [
            { reviewer: "security", verdict: "approve", confirmed_blockers: 0 },
            { reviewer: "quality", verdict: "approve", confirmed_blockers: 0 },
          ],
        },
        {
          task_id: "b",
          status: "done",
          escalation_rung: 2,
          reviewers: [{ reviewer: "architecture", verdict: "approve", confirmed_blockers: 0 }],
        },
      ]),
      report({ totals: { total: 2, shipped: 2, failed: 0, incomplete: 0 } }),
      { now: NOW },
    );
    expect(summary.effort).toEqual({ reviewer_results: 3, max_escalation_rung: 2 });
  });

  it("is zeroed when no task reviewed or escalated", () => {
    const summary = buildRunSummary(mkRun([{ task_id: "a", status: "pending" }]), report(), {
      now: NOW,
    });
    expect(summary.effort).toEqual({ reviewer_results: 0, max_escalation_rung: 0 });
  });
});

describe("buildRunSummary — shipped_prs", () => {
  it("mirrors the report's shipped lines, preserving/omitting PR pointers", () => {
    const summary = buildRunSummary(
      mkRun([
        { task_id: "a", status: "done" },
        { task_id: "b", status: "done" },
      ]),
      report({
        shipped: [
          { task_id: "a", title: "A", pr_number: 9, branch: "factory/run/a" },
          { task_id: "b", title: "B" },
        ],
        totals: { total: 2, shipped: 2, failed: 0, incomplete: 0 },
      }),
      { now: NOW },
    );
    expect(summary.shipped_prs).toEqual([
      { task_id: "a", pr_number: 9, branch: "factory/run/a" },
      { task_id: "b" },
    ]);
  });
});

describe("buildRunSummary — timing", () => {
  it("computes whole-second duration between started_at and ended_at", () => {
    const summary = buildRunSummary(
      mkRun([{ task_id: "a", status: "done" }], {
        status: "completed",
        started_at: "2026-06-08T00:00:00.000Z",
        ended_at: "2026-06-08T01:02:03.000Z",
      }),
      report({ run_status: "completed" }),
      { now: NOW },
    );
    expect(summary.timing.duration_seconds).toBe(3723); // 1h 2m 3s
    expect(summary.timing.ended_at).toBe("2026-06-08T01:02:03.000Z");
  });

  it("duration is null while the run has not ended", () => {
    const summary = buildRunSummary(
      mkRun([{ task_id: "a", status: "executing" }], { status: "running", ended_at: null }),
      report({ run_status: "running" }),
      { now: NOW },
    );
    expect(summary.timing.ended_at).toBeNull();
    expect(summary.timing.duration_seconds).toBeNull();
  });

  it("duration is null for a negative (clock-skewed) delta, never a misleading number", () => {
    const summary = buildRunSummary(
      mkRun([{ task_id: "a", status: "done" }], {
        status: "completed",
        started_at: "2026-06-08T01:00:00.000Z",
        ended_at: "2026-06-08T00:00:00.000Z",
      }),
      report({ run_status: "completed" }),
      { now: NOW },
    );
    expect(summary.timing.duration_seconds).toBeNull();
  });
});

describe("buildRunSummary — passthrough + clock", () => {
  it("carries the run/spec identity and pins generated_at to the injected now", () => {
    const summary = buildRunSummary(mkRun([{ task_id: "a", status: "done" }]), report(), {
      now: NOW,
    });
    expect(summary).toMatchObject({
      run_id: "run-sum-1",
      run_status: "failed",
      execution_mode: "balanced",
      spec_id: "7-x",
      issue_number: 7,
      repo: "acme/widgets",
      generated_at: NOW,
    });
  });

  it("defaults generated_at to a real ISO stamp when now is omitted", () => {
    const summary = buildRunSummary(mkRun([{ task_id: "a", status: "done" }]), report());
    expect(summary.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("renderRunSummaryMarkdown", () => {
  it("renders a compact headline with the fails line when there are fails", () => {
    const summary = buildRunSummary(
      mkRun([
        { task_id: "a", status: "done" },
        { task_id: "b", status: "failed", failure_class: "spec-defect" },
      ]),
      report({
        totals: { total: 2, shipped: 1, failed: 1, incomplete: 0 },
        failures: [
          {
            task_id: "b",
            title: "B",
            failure_class: "spec-defect",
            failure_reason: "x",
            unmet_criteria: [],
          },
        ],
      }),
      { now: NOW },
    );
    const md = renderRunSummaryMarkdown(summary);
    expect(md).toContain("## Run summary — `run-sum-1`");
    expect(md).toContain("**FAILED**");
    expect(md).toContain("1 shipped");
    expect(md).toContain("**Failures:** 1 spec-defect");
  });

  it("omits the fails line entirely when nothing failed", () => {
    const summary = buildRunSummary(
      mkRun([{ task_id: "a", status: "done" }], { status: "completed" }),
      report({
        run_status: "completed",
        totals: { total: 1, shipped: 1, failed: 0, incomplete: 0 },
      }),
      { now: NOW },
    );
    expect(renderRunSummaryMarkdown(summary)).not.toContain("**Failures:**");
  });
});

describe("tasks_without_cross_vendor (Δ U/S5)", () => {
  it("counts the report's cross_vendor_absences and renders the review-independence line", () => {
    const summary = buildRunSummary(
      mkRun([{ task_id: "a", status: "done" }], { status: "completed" }),
      report({
        run_status: "completed",
        totals: { total: 1, shipped: 1, failed: 0, incomplete: 0 },
        cross_vendor_absences: [
          { task_id: "a", reason: "no cross-vendor model configured (codex.model)" },
        ],
      }),
      { now: NOW },
    );
    expect(summary.tasks_without_cross_vendor).toBe(1);
    expect(renderRunSummaryMarkdown(summary)).toContain(
      "**Review independence:** 1 task(s) reviewed without a second-vendor reviewer",
    );
  });

  it("is 0 (and the line omitted) when the report has no absences", () => {
    const summary = buildRunSummary(
      mkRun([{ task_id: "a", status: "done" }], { status: "completed" }),
      report({ run_status: "completed" }),
      { now: NOW },
    );
    expect(summary.tasks_without_cross_vendor).toBe(0);
    expect(renderRunSummaryMarkdown(summary)).not.toContain("Review independence");
  });
});
