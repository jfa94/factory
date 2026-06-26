/**
 * WS12 — rescue SCAN (the read-only diagnostic; Decision 22, Δ S).
 *
 * `scanRun` is pure over {@link RunState}, so these tests build run states directly
 * via {@link parseRunState} and assert the classification contract:
 *   - disposition: done→shipped, pending→runnable, in-flight→stuck,
 *     failed+blocked-environmental→recoverable, failed+other→dead-end;
 *   - resettable = stuck ∪ recoverable; dead_ends = the dead-end failures;
 *   - needs_rescue iff anything is resettable;
 *   - would_deadlock iff non-terminal work remains but no pending task is actionable
 *     (the driver's deadlock guard) — distinct from needs_rescue;
 *   - per-task lines carry the failure/branch/PR passthrough;
 *   - the summary flags reopen (terminal run) + deadlock.
 */
import { describe, it, expect } from "vitest";
import { scanRun } from "./scan.js";
import { parseRunState } from "../core/state/index.js";
import type { RunState, RunStatus, TaskState } from "../types/index.js";

/** A loose task seed; defaults fill the non-relevant fields. */
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
  // A failed row must carry the classification (cross-field invariant).
  if (seed.status === "failed") {
    return {
      failure_class: "capability-budget" as const,
      failure_reason: "ran out of retries",
      ...base,
    };
  }
  return base;
}

function mkRun(seeds: readonly TaskSeed[], status: RunStatus = "running"): RunState {
  return parseRunState({
    run_id: "run-scan-1",
    status,
    spec: { repo: "acme/widgets", spec_id: "7-x", issue_number: 7 },
    tasks: Object.fromEntries(seeds.map((s) => [s.task_id, task(s)])),
    started_at: "2026-06-08T00:00:00.000Z",
    updated_at: "2026-06-08T00:00:00.000Z",
  });
}

describe("scanRun — disposition", () => {
  it("classifies every status into its disposition", () => {
    const scan = scanRun(
      mkRun([
        { task_id: "shipped", status: "done" },
        { task_id: "runnable", status: "pending" },
        { task_id: "stuck-x", status: "executing" },
        { task_id: "stuck-r", status: "reviewing" },
        { task_id: "stuck-s", status: "shipping" },
        { task_id: "recover", status: "failed", failure_class: "blocked-environmental" },
        { task_id: "dead-spec", status: "failed", failure_class: "spec-defect" },
        { task_id: "dead-cap", status: "failed", failure_class: "capability-budget" },
      ]),
    );
    const disp = Object.fromEntries(scan.tasks.map((t) => [t.task_id, t.disposition]));
    expect(disp).toEqual({
      shipped: "shipped",
      runnable: "runnable",
      "stuck-x": "stuck",
      "stuck-r": "stuck",
      "stuck-s": "stuck",
      recover: "recoverable",
      "dead-spec": "dead-end",
      "dead-cap": "dead-end",
    });
    expect(scan.counts).toEqual({
      total: 8,
      shipped: 1,
      runnable: 1,
      stuck: 3,
      recoverable: 1,
      dead_end: 2,
    });
  });
});

describe("scanRun — resettable / dead_ends / needs_rescue", () => {
  it("resettable = stuck ∪ recoverable; dead_ends excluded", () => {
    const scan = scanRun(
      mkRun([
        { task_id: "a", status: "executing" },
        { task_id: "b", status: "failed", failure_class: "blocked-environmental" },
        { task_id: "c", status: "failed", failure_class: "spec-defect" },
        { task_id: "d", status: "done" },
      ]),
    );
    expect(scan.resettable).toEqual(["a", "b"]);
    expect(scan.dead_ends).toEqual(["c"]);
    expect(scan.needs_rescue).toBe(true);
  });

  it("needs_rescue is false when nothing is stuck or recoverable", () => {
    const scan = scanRun(
      mkRun([
        { task_id: "a", status: "done" },
        { task_id: "c", status: "failed", failure_class: "spec-defect" },
      ]),
    );
    expect(scan.resettable).toEqual([]);
    expect(scan.needs_rescue).toBe(false);
    expect(scan.summary).toMatch(/no rescue needed/);
    expect(scan.summary).toMatch(/dead-end/); // names the unrecoverable fail
  });

  it("carries failure/branch/PR passthrough on the task lines", () => {
    const scan = scanRun(
      mkRun([
        { task_id: "a", status: "shipping", branch: "factory/run/a", pr_number: 9 },
        {
          task_id: "b",
          status: "failed",
          failure_class: "spec-defect",
          failure_reason: "criterion unattainable",
        },
      ]),
    );
    const a = scan.tasks.find((t) => t.task_id === "a")!;
    expect(a).toMatchObject({ branch: "factory/run/a", pr_number: 9 });
    const b = scan.tasks.find((t) => t.task_id === "b")!;
    expect(b).toMatchObject({
      failure_class: "spec-defect",
      failure_reason: "criterion unattainable",
    });
  });
});

describe("scanRun — would_deadlock (the driver's guard, mirrored)", () => {
  it("is true when a stuck task blocks the only dependent pending task", () => {
    // A crashed mid-phase (executing); B waits on A → neither is actionable.
    const scan = scanRun(
      mkRun([
        { task_id: "a", status: "executing" },
        { task_id: "b", status: "pending", depends_on: ["a"] },
      ]),
    );
    expect(scan.would_deadlock).toBe(true);
    expect(scan.needs_rescue).toBe(true);
    expect(scan.summary).toMatch(/deadlock/);
  });

  it("is false when a pending task is still actionable despite a stuck task", () => {
    // A is stuck, but B is an independent ready task → the driver can make progress.
    const scan = scanRun(
      mkRun([
        { task_id: "a", status: "executing" },
        { task_id: "b", status: "pending", depends_on: [] },
      ]),
    );
    expect(scan.would_deadlock).toBe(false);
    expect(scan.needs_rescue).toBe(true); // still stuck → still needs rescue
  });

  it("is false for an all-terminal run (already finalized, never deadlocked)", () => {
    const scan = scanRun(
      mkRun(
        [
          { task_id: "a", status: "done" },
          { task_id: "b", status: "failed", failure_class: "blocked-environmental" },
        ],
        "failed",
      ),
    );
    expect(scan.would_deadlock).toBe(false);
    // a recoverable fail on a terminal run still needs rescue (retry on reopen).
    expect(scan.needs_rescue).toBe(true);
  });

  it("treats a pending task whose dep was failed as actionable (cascade-failable)", () => {
    const scan = scanRun(
      mkRun([
        { task_id: "a", status: "failed", failure_class: "spec-defect" },
        { task_id: "b", status: "pending", depends_on: ["a"] },
      ]),
    );
    // B's dep is failed → the driver cascade-fails B; not a deadlock.
    expect(scan.would_deadlock).toBe(false);
  });
});

describe("scanRun — summary", () => {
  it("flags that a terminal run will reopen", () => {
    const scan = scanRun(
      mkRun(
        [
          { task_id: "a", status: "done" },
          { task_id: "b", status: "failed", failure_class: "blocked-environmental" },
        ],
        "failed",
      ),
    );
    expect(scan.summary).toMatch(/will reopen the run/);
  });
});
