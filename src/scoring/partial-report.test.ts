import { describe, it, expect } from "vitest";
import {
  buildPartialReport,
  renderPartialReportMarkdown,
  renderFailureComment,
  failureCommentMarker,
} from "./partial-report.js";
import { parseRunState, type RunState, type TaskState } from "../types/index.js";
import { parseSpecManifest, type SpecManifest, type SpecTask } from "../spec/schema.js";

// ---------------------------------------------------------------------------
// Builders — minimal valid RunState / SpecManifest fixtures.
// ---------------------------------------------------------------------------

function specTask(id: string, overrides: Partial<SpecTask> = {}): SpecTask {
  return {
    task_id: id,
    title: `Title ${id}`,
    description: `Does ${id}`,
    files: [`src/${id}.ts`],
    acceptance_criteria: [`${id} criterion one`, `${id} criterion two`],
    tests_to_write: [`${id}.test.ts: asserts one`, `${id}.test.ts: asserts two`],
    depends_on: [],
    risk_tier: "medium",
    risk_rationale: "contained blast radius",
    ...overrides,
  };
}

function makeSpec(tasks: SpecTask[]): SpecManifest {
  return parseSpecManifest({
    spec_id: "42-checkout",
    issue_number: 42,
    slug: "checkout",
    repo: "acme/widgets",
    generated_at: "2026-01-01T00:00:00.000Z",
    tasks,
  });
}

function doneTask(id: string, pr: number): TaskState {
  return {
    task_id: id,
    status: "done",
    branch: `factory/run-1/${id}`,
    pr_number: pr,
  } as TaskState;
}

function droppedTask(
  id: string,
  failure_class: TaskState["failure_class"],
  reason: string,
): TaskState {
  return {
    task_id: id,
    status: "dropped",
    failure_class,
    failure_reason: reason,
  } as TaskState;
}

function pendingTask(id: string, status: TaskState["status"] = "pending"): TaskState {
  return { task_id: id, status } as TaskState;
}

function makeRun(tasks: TaskState[], overrides: Partial<RunState> = {}): RunState {
  const record: Record<string, TaskState> = {};
  for (const t of tasks) record[t.task_id] = t;
  return parseRunState({
    schema_version: 1,
    run_id: "run-1",
    status: "failed",
    driver: "balanced",
    spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
    tasks: record,
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T01:00:00.000Z",
    ended_at: "2026-01-01T01:00:00.000Z",
    ...overrides,
  });
}

const NOW = "2026-02-02T12:00:00.000Z";

// ---------------------------------------------------------------------------

describe("buildPartialReport", () => {
  it("classifies a partial run into shipped + failures with derived unmet criteria", () => {
    const spec = makeSpec([specTask("t1"), specTask("t2"), specTask("t3")]);
    const run = makeRun([
      doneTask("t1", 11),
      doneTask("t2", 12),
      droppedTask("t3", "capability-budget", "ladder exhausted"),
    ]);

    const report = buildPartialReport(run, spec, { now: NOW });

    expect(report.run_status).toBe("failed");
    expect(report.totals).toEqual({ total: 3, shipped: 2, failed: 1, incomplete: 0 });
    expect(report.generated_at).toBe(NOW);
    expect(report.spec_id).toBe("42-checkout");
    expect(report.issue_number).toBe(42);

    expect(report.shipped.map((s) => s.task_id)).toEqual(["t1", "t2"]);
    expect(report.shipped[0]).toMatchObject({ title: "Title t1", pr_number: 11 });

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({
      task_id: "t3",
      failure_class: "capability-budget",
      failure_reason: "ladder exhausted",
      unmet_criteria: ["t3 criterion one", "t3 criterion two"],
    });
  });

  it("orders output by spec position, not by run.tasks insertion order", () => {
    const spec = makeSpec([specTask("a"), specTask("b"), specTask("c")]);
    // Insert in reverse order.
    const run = makeRun([doneTask("c", 3), doneTask("b", 2), doneTask("a", 1)], {
      status: "completed",
    });

    const report = buildPartialReport(run, spec, { now: NOW });
    expect(report.shipped.map((s) => s.task_id)).toEqual(["a", "b", "c"]);
  });

  it("a completed run has no failures or incompletes", () => {
    const spec = makeSpec([specTask("t1")]);
    const run = makeRun([doneTask("t1", 1)], { status: "completed" });

    const report = buildPartialReport(run, spec, { now: NOW });
    expect(report.totals).toEqual({ total: 1, shipped: 1, failed: 0, incomplete: 0 });
    expect(report.failures).toEqual([]);
    expect(report.incomplete).toEqual([]);
  });

  it("a failed run (nothing shipped) lists all drops, no shipped", () => {
    const spec = makeSpec([specTask("t1"), specTask("t2")]);
    const run = makeRun(
      [
        droppedTask("t1", "spec-defect", "untestable criterion"),
        droppedTask("t2", "blocked-environmental", "dependency dropped"),
      ],
      { status: "failed" },
    );

    const report = buildPartialReport(run, spec, { now: NOW });
    expect(report.shipped).toEqual([]);
    expect(report.totals).toEqual({ total: 2, shipped: 0, failed: 2, incomplete: 0 });
    expect(report.failures.map((f) => f.failure_class)).toEqual([
      "spec-defect",
      "blocked-environmental",
    ]);
  });

  it("lists non-terminal tasks as incomplete (suspended run)", () => {
    const spec = makeSpec([specTask("t1"), specTask("t2"), specTask("t3")]);
    const run = makeRun(
      [doneTask("t1", 1), pendingTask("t2", "executing"), pendingTask("t3", "pending")],
      { status: "suspended", ended_at: null },
    );

    const report = buildPartialReport(run, spec, { now: NOW });
    expect(report.totals).toEqual({ total: 3, shipped: 1, failed: 0, incomplete: 2 });
    expect(report.incomplete.map((i) => `${i.task_id}:${i.status}`)).toEqual([
      "t2:executing",
      "t3:pending",
    ]);
  });

  it("throws loud when a run task is absent from the spec (run/spec mismatch)", () => {
    const spec = makeSpec([specTask("t1")]);
    const run = makeRun([doneTask("t1", 1), doneTask("ghost", 2)], { status: "completed" });

    expect(() => buildPartialReport(run, spec, { now: NOW })).toThrow(/ghost.*absent from spec/);
  });

  it("carries branch/pr pointers through to failures when present", () => {
    const spec = makeSpec([specTask("t1")]);
    const dropped: TaskState = {
      ...droppedTask("t1", "capability-budget", "exhausted"),
      branch: "factory/run-1/t1",
      pr_number: 99,
    };
    const run = makeRun([dropped], { status: "failed" });

    const report = buildPartialReport(run, spec, { now: NOW });
    expect(report.failures[0]).toMatchObject({ branch: "factory/run-1/t1", pr_number: 99 });
  });
});

describe("renderPartialReportMarkdown", () => {
  it("renders status, totals, shipped + failed sections with criteria", () => {
    const spec = makeSpec([specTask("t1"), specTask("t2")]);
    const run = makeRun([
      doneTask("t1", 11),
      droppedTask("t2", "capability-budget", "ladder exhausted"),
    ]);

    const md = renderPartialReportMarkdown(buildPartialReport(run, spec, { now: NOW }));

    expect(md).toContain("# Factory run report — `run-1`");
    expect(md).toContain("**Status:** FAILED");
    expect(md).toContain("PRD #42");
    expect(md).toContain("2 total · 1 shipped · 1 failed · 0 incomplete");
    expect(md).toContain("## Shipped (1)");
    expect(md).toContain("- `t1` — Title t1 — PR #11 (`factory/run-1/t1`)");
    expect(md).toContain("## Failed (1)");
    expect(md).toContain("### `t2` — Title t2");
    expect(md).toContain("- **Class:** `capability-budget`");
    expect(md).toContain("  - t2 criterion one");
  });

  it("omits the Failed and Incomplete sections for a completed run", () => {
    const spec = makeSpec([specTask("t1")]);
    const run = makeRun([doneTask("t1", 1)], { status: "completed" });
    const md = renderPartialReportMarkdown(buildPartialReport(run, spec, { now: NOW }));

    expect(md).toContain("## Shipped (1)");
    expect(md).not.toContain("## Failed");
    expect(md).not.toContain("## Incomplete");
  });

  it("shows _none_ when nothing shipped", () => {
    const spec = makeSpec([specTask("t1")]);
    const run = makeRun([droppedTask("t1", "spec-defect", "untestable")], { status: "failed" });
    const md = renderPartialReportMarkdown(buildPartialReport(run, spec, { now: NOW }));

    expect(md).toContain("## Shipped (0)");
    expect(md).toContain("_none_");
  });
});

describe("failureCommentMarker", () => {
  it("embeds the run id in a hidden HTML comment", () => {
    expect(failureCommentMarker("run-1")).toBe("<!-- factory:run-failed:run-1 -->");
  });
});

describe("renderFailureComment", () => {
  it("leads with the marker and renders one block per drop with unmet criteria checkboxes", () => {
    const spec = makeSpec([specTask("t1"), specTask("t2")]);
    const run = makeRun(
      [
        droppedTask("t1", "capability-budget", "ladder exhausted at rung 2"),
        droppedTask("t2", "spec-defect", "criterion unattainable"),
      ],
      { status: "failed" },
    );
    const report = buildPartialReport(run, spec, { now: NOW });
    const body = renderFailureComment(report);

    // Marker is the very first line → finalize's dedup scan finds it on re-entry.
    expect(body.startsWith(failureCommentMarker("run-1"))).toBe(true);
    expect(body).toContain("Factory run `run-1` failed — 2 task(s) dropped");
    expect(body).toContain("PRD left open for rescue/resume");
    // One block per dropped task.
    expect(body).toContain("### `t1` — Title t1");
    expect(body).toContain("- **Class:** `capability-budget`");
    expect(body).toContain("- **Reason:** ladder exhausted at rung 2");
    expect(body).toContain("### `t2` — Title t2");
    expect(body).toContain("- **Class:** `spec-defect`");
    // Full acceptance criteria rendered as unmet checkboxes.
    expect(body).toContain("  - [ ] t1 criterion one");
    expect(body).toContain("  - [ ] t1 criterion two");
  });

  it("includes branch + PR pointers when present", () => {
    const spec = makeSpec([specTask("t1")]);
    const dropped: TaskState = {
      ...droppedTask("t1", "blocked-environmental", "CI infra down"),
      branch: "factory/run-1/t1",
      pr_number: 7,
    };
    const run = makeRun([dropped], { status: "failed" });
    const report = buildPartialReport(run, spec, { now: NOW });
    const body = renderFailureComment(report);

    expect(body).toContain("- **Branch:** `factory/run-1/t1`");
    expect(body).toContain("- **PR:** #7");
  });
});
