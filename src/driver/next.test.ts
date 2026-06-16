/**
 * Unit tests for pumpRun — the run-level pump.
 *
 * Each test uses makePumpDeps from pump-fixtures.ts. MakePumpDepsOpts supports:
 *   - tasks: multi-task DAGs with depends_on
 *   - taskStateOverrides: per-task status overrides
 *   - usage: quota reading
 *   - runStatusOverride: seed the run with a non-"running" status after creation
 *
 * State writes that bypass seeding (e.g., for pathological DAGs) use
 * deps.state.update / deps.state.updateTask directly in the test body.
 */
import { describe, expect, it } from "vitest";

import { pumpRun } from "./next.js";
import { makePumpDeps, PAUSE_5H } from "./pump-fixtures.js";
import type { UsageReading } from "../quota/usage-source.js";

const UNAVAILABLE: UsageReading = { kind: "unavailable", reason: "usage-cache-missing" };

describe("pumpRun", () => {
  it("terminal run → run-terminal", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({
      runStatusOverride: "completed",
    });
    try {
      const env = await pumpRun(deps, runId);
      expect(env).toMatchObject({ kind: "run-terminal", run_status: "completed" });
    } finally {
      await cleanup();
    }
  });

  it("quota breach → quota-blocked with persisted checkpoint", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({ usage: PAUSE_5H });
    try {
      const env = await pumpRun(deps, runId);
      expect(env).toMatchObject({ kind: "quota-blocked", scope: "5h" });
      const run = await deps.state.read(runId);
      expect(run.status).toBe("paused");
    } finally {
      await cleanup();
    }
  });

  it("workflow mode proceeds past the gate even with an unobservable usage signal", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({
      modeOverride: "workflow",
      usage: UNAVAILABLE,
    });
    try {
      const env = await pumpRun(deps, runId);
      expect(env.kind).toBe("tasks-ready");
      expect((await deps.state.read(runId)).status).toBe("running");
    } finally {
      await cleanup();
    }
  });

  it("session mode (default) fail-closes on the same unobservable signal", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({ usage: UNAVAILABLE });
    try {
      const env = await pumpRun(deps, runId);
      expect(env).toMatchObject({ kind: "quota-blocked", scope: "unavailable" });
      expect((await deps.state.read(runId)).status).toBe("suspended");
    } finally {
      await cleanup();
    }
  });

  it("recovered paused run is returned to running before reporting ready tasks", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["only one"] }],
    });
    try {
      // Seed a realistic paused state with a real quota checkpoint so the
      // quota-cleared assertion discriminates (rather than being vacuously true).
      await deps.state.update(runId, (s) => ({
        ...s,
        status: "paused" as const,
        quota: { binding_window: "5h" as const, resets_at_epoch: 1_700_018_000 },
      }));
      const env = await pumpRun(deps, runId);
      expect(env.kind).toBe("tasks-ready");
      const run = await deps.state.read(runId);
      expect(run.status).toBe("running");
      // quota checkpoint must be cleared (the clearCheckpoint block)
      expect(run.quota).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("cascade-drops pending tasks whose dependency dropped, transitively", async () => {
    // T1 dropped; T2 depends_on [T1]; T3 depends_on [T2]; T4 independent pending
    const { deps, runId, cleanup } = await makePumpDeps({
      tasks: [
        { task_id: "T1", acceptance_criteria: ["only one"] },
        { task_id: "T2", acceptance_criteria: ["only one"], depends_on: ["T1"] },
        { task_id: "T3", acceptance_criteria: ["only one"], depends_on: ["T2"] },
        { task_id: "T4", acceptance_criteria: ["only one"] },
      ],
    });
    try {
      // Seed T1 as dropped
      await deps.state.updateTask(runId, "T1", (t) => ({
        ...t,
        status: "dropped",
        failure_class: "capability-budget",
        failure_reason: "test seed",
      }));

      const env = await pumpRun(deps, runId);
      expect(env.kind).toBe("tasks-ready");
      if (env.kind !== "tasks-ready") return;
      expect(env.cascade_dropped.slice().sort()).toEqual(["T2", "T3"]);
      expect(env.ready).toEqual(["T4"]);
      const run = await deps.state.read(runId);
      expect(run.tasks["T2"]?.failure_class).toBe("blocked-environmental");
    } finally {
      await cleanup();
    }
  });

  it("ready excludes tasks with un-done deps and orders in-flight (crash-resume) first", async () => {
    // T1 done; T2 pending depends_on [T1]; T3 status reviewing (in-flight, stage verify); T4 pending depends_on [T2]
    const { deps, runId, cleanup } = await makePumpDeps({
      tasks: [
        { task_id: "T1", acceptance_criteria: ["only one"] },
        { task_id: "T2", acceptance_criteria: ["only one"], depends_on: ["T1"] },
        { task_id: "T3", acceptance_criteria: ["only one"] },
        { task_id: "T4", acceptance_criteria: ["only one"], depends_on: ["T2"] },
      ],
    });
    try {
      // Seed T1 as done, T3 as reviewing (in-flight)
      await deps.state.updateTask(runId, "T1", (t) => ({ ...t, status: "done" }));
      await deps.state.updateTask(runId, "T3", (t) => ({
        ...t,
        status: "reviewing",
        stage: "verify",
      }));

      const env = await pumpRun(deps, runId);
      expect(env).toMatchObject({ kind: "tasks-ready", ready: ["T3", "T2"] });
      if (env.kind !== "tasks-ready") return;
      // T4 not ready (T2 not done), T1 terminal
      expect(env.ready).not.toContain("T1");
      expect(env.ready).not.toContain("T4");
    } finally {
      await cleanup();
    }
  });

  it("all tasks terminal → all-terminal", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({
      tasks: [
        { task_id: "T1", acceptance_criteria: ["only one"] },
        { task_id: "T2", acceptance_criteria: ["only one"] },
      ],
    });
    try {
      // Seed T1 done, T2 dropped
      await deps.state.updateTask(runId, "T1", (t) => ({ ...t, status: "done" }));
      await deps.state.updateTask(runId, "T2", (t) => ({
        ...t,
        status: "dropped",
        failure_class: "capability-budget",
        failure_reason: "test seed",
      }));

      const env = await pumpRun(deps, runId);
      expect(env).toMatchObject({ kind: "all-terminal" });
    } finally {
      await cleanup();
    }
  });

  it("non-terminal tasks but none ready → throws deadlock", async () => {
    // Pathological DAG: T1 executing with depends_on [T2], T2 pending depends_on [T1]
    // This bypasses seeding via direct state writes.
    const { deps, runId, cleanup } = await makePumpDeps({
      tasks: [
        { task_id: "T1", acceptance_criteria: ["only one"] },
        { task_id: "T2", acceptance_criteria: ["only one"] },
      ],
    });
    try {
      // Construct the cycle directly, bypassing normal seeding
      await deps.state.update(runId, (s) => ({
        ...s,
        tasks: {
          T1: {
            ...s.tasks["T1"]!,
            status: "executing" as const,
            depends_on: ["T2"],
          },
          T2: {
            ...s.tasks["T2"]!,
            status: "pending" as const,
            depends_on: ["T1"],
          },
        },
      }));

      await expect(pumpRun(deps, runId)).rejects.toThrow(/deadlock|cycle/);
    } finally {
      await cleanup();
    }
  });

  it("terminal run + quota-breach → run-terminal (no checkpoint written)", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({
      usage: PAUSE_5H,
      runStatusOverride: "completed",
    });
    try {
      const env = await pumpRun(deps, runId);
      expect(env).toMatchObject({ kind: "run-terminal", run_status: "completed" });
      // Gate never ran — no checkpoint written
      const run = await deps.state.read(runId);
      expect(run.quota).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  // C1 pin: all tasks already terminal + 5h-breaching usage → all-terminal, no
  // checkpoint written (the pre-gate all-terminal check fires before applyQuotaGate).
  it("all-tasks-terminal + quota-breach → all-terminal with no checkpoint written", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["only one"] }],
      usage: PAUSE_5H,
    });
    try {
      // Seed T1 as done so the run is effectively finished
      await deps.state.updateTask(runId, "T1", (t) => ({ ...t, status: "done" }));

      const env = await pumpRun(deps, runId);
      expect(env).toMatchObject({ kind: "all-terminal", cascade_dropped: [] });
      // The quota gate must NOT have run — run stays running with no checkpoint
      const run = await deps.state.read(runId);
      expect(run.status).toBe("running");
      expect(run.quota).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  // I1 pin: cascade that resolves the run to all-terminal carries the dropped ids.
  it("cascade resolving run to all-terminal → all-terminal with cascade_dropped", async () => {
    // T1 dropped; T2 pending depends_on [T1] — cascade drops T2, run is all-terminal.
    const { deps, runId, cleanup } = await makePumpDeps({
      tasks: [
        { task_id: "T1", acceptance_criteria: ["only one"] },
        { task_id: "T2", acceptance_criteria: ["only one"], depends_on: ["T1"] },
      ],
    });
    try {
      await deps.state.updateTask(runId, "T1", (t) => ({
        ...t,
        status: "dropped",
        failure_class: "capability-budget",
        failure_reason: "test seed",
      }));

      const env = await pumpRun(deps, runId);
      expect(env).toMatchObject({ kind: "all-terminal", cascade_dropped: ["T2"] });
    } finally {
      await cleanup();
    }
  });

  // Suspended recovery: a suspended run with a 7d checkpoint resumes cleanly.
  it("suspended run (7d checkpoint) is returned to running before reporting ready tasks", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["only one"] }],
    });
    try {
      await deps.state.update(runId, (s) => ({
        ...s,
        status: "suspended" as const,
        quota: { binding_window: "7d" as const, resets_at_epoch: 1_700_018_000 },
      }));
      const env = await pumpRun(deps, runId);
      expect(env.kind).toBe("tasks-ready");
      const run = await deps.state.read(runId);
      expect(run.status).toBe("running");
      expect(run.quota).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  // Empty run (tasks: {}) → all-terminal with empty cascade_dropped.
  it("empty run (no tasks) → all-terminal with cascade_dropped []", async () => {
    const { deps, runId, cleanup } = await makePumpDeps();
    try {
      // Clear the default T1 so the run has zero tasks
      await deps.state.update(runId, (s) => ({ ...s, tasks: {} }));

      const env = await pumpRun(deps, runId);
      expect(env).toMatchObject({ kind: "all-terminal", cascade_dropped: [] });
    } finally {
      await cleanup();
    }
  });

  // Empty run + quota breach → all-terminal pre-gate (vacuously finished; e.g. a
  // crash between state.create and task seeding). The gate must NOT run — the
  // step-2 and step-6 all-terminal semantics agree on tasks: {}.
  it("empty run + quota-breach → all-terminal with no checkpoint written", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({ usage: PAUSE_5H });
    try {
      await deps.state.update(runId, (s) => ({ ...s, tasks: {} }));

      const env = await pumpRun(deps, runId);
      expect(env).toMatchObject({ kind: "all-terminal", cascade_dropped: [] });
      const run = await deps.state.read(runId);
      expect(run.status).toBe("running");
      expect(run.quota).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  // Self-dependency deadlock: T1 depends_on ["T1"] — must throw /deadlock|cycle/.
  it("self-dependency (T1 depends_on T1) → throws deadlock", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["only one"] }],
    });
    try {
      // Inject the self-dep directly, bypassing normal seeding
      await deps.state.updateTask(runId, "T1", (t) => ({
        ...t,
        depends_on: ["T1"],
      }));

      await expect(pumpRun(deps, runId)).rejects.toThrow(/deadlock|cycle/);
    } finally {
      await cleanup();
    }
  });
});
