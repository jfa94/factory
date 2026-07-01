/**
 * Unit tests for nextTask — the run-level orchestrator.
 *
 * Each test uses makeOrchestratorDeps from orchestrator-fixtures.ts. MakeOrchestratorDepsOpts supports:
 *   - tasks: multi-task DAGs with depends_on
 *   - taskStateOverrides: per-task status overrides
 *   - usage: quota reading
 *   - runStatusOverride: seed the run with a non-"running" status after creation
 *
 * State writes that bypass seeding (e.g., for pathological DAGs) use
 * deps.state.update / deps.state.updateTask directly in the test body.
 */
import { describe, expect, it } from "vitest";

import { nextTask } from "./next.js";
import { makeOrchestratorDeps, PAUSE_5H } from "./orchestrator-fixtures.js";
import type { UsageReading } from "../quota/usage-source.js";

const UNAVAILABLE: UsageReading = { kind: "unavailable", reason: "usage-cache-missing" };

describe("nextTask", () => {
  it("terminal run → run-terminal", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      runStatusOverride: "completed",
    });
    try {
      const env = await nextTask(deps, runId);
      expect(env).toMatchObject({ kind: "done", run_status: "completed" });
    } finally {
      await cleanup();
    }
  });

  it("quota breach → quota-blocked with persisted checkpoint", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({ usage: PAUSE_5H });
    try {
      const env = await nextTask(deps, runId);
      expect(env).toMatchObject({ kind: "pause", scope: "5h" });
      const run = await deps.state.read(runId);
      expect(run.status).toBe("paused");
    } finally {
      await cleanup();
    }
  });

  it("workflow mode proceeds past the gate even with an unobservable usage signal", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      modeOverride: "workflow",
      usage: UNAVAILABLE,
    });
    try {
      const env = await nextTask(deps, runId);
      expect(env.kind).toBe("work");
      expect((await deps.state.read(runId)).status).toBe("running");
    } finally {
      await cleanup();
    }
  });

  it("session mode (default) fail-closes on the same unobservable signal", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({ usage: UNAVAILABLE });
    try {
      const env = await nextTask(deps, runId);
      expect(env).toMatchObject({ kind: "pause", scope: "unavailable" });
      expect((await deps.state.read(runId)).status).toBe("suspended");
    } finally {
      await cleanup();
    }
  });

  it("recovered paused run is returned to running before reporting ready tasks", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
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
      const env = await nextTask(deps, runId);
      expect(env.kind).toBe("work");
      const run = await deps.state.read(runId);
      expect(run.status).toBe("running");
      // quota checkpoint must be cleared (the clearCheckpoint block)
      expect(run.quota).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("cascade-fails pending tasks whose dependency failed, transitively", async () => {
    // T1 failed; T2 depends_on [T1]; T3 depends_on [T2]; T4 independent pending
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      tasks: [
        { task_id: "T1", acceptance_criteria: ["only one"] },
        { task_id: "T2", acceptance_criteria: ["only one"], depends_on: ["T1"] },
        { task_id: "T3", acceptance_criteria: ["only one"], depends_on: ["T2"] },
        { task_id: "T4", acceptance_criteria: ["only one"] },
      ],
    });
    try {
      // Seed T1 as failed
      await deps.state.updateTask(runId, "T1", (t) => ({
        ...t,
        status: "failed",
        failure_class: "capability-budget",
        failure_reason: "test seed",
      }));

      const env = await nextTask(deps, runId);
      expect(env.kind).toBe("work");
      if (env.kind !== "work") return;
      expect(env.cascade_failed.slice().sort()).toEqual(["T2", "T3"]);
      expect(env.ready).toEqual(["T4"]);
      const run = await deps.state.read(runId);
      expect(run.tasks["T2"]?.failure_class).toBe("blocked-environmental");
    } finally {
      await cleanup();
    }
  });

  it("ready excludes tasks with un-done deps and orders in-flight (crash-resume) first", async () => {
    // T1 done; T2 pending depends_on [T1]; T3 status reviewing (in-flight, phase verify); T4 pending depends_on [T2]
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
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
        phase: "verify",
      }));

      const env = await nextTask(deps, runId);
      expect(env).toMatchObject({ kind: "work", ready: ["T3", "T2"] });
      if (env.kind !== "work") return;
      // T4 not ready (T2 not done), T1 terminal
      expect(env.ready).not.toContain("T1");
      expect(env.ready).not.toContain("T4");
    } finally {
      await cleanup();
    }
  });

  it("all tasks terminal → all-terminal", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      tasks: [
        { task_id: "T1", acceptance_criteria: ["only one"] },
        { task_id: "T2", acceptance_criteria: ["only one"] },
      ],
    });
    try {
      // Seed T1 done, T2 failed
      await deps.state.updateTask(runId, "T1", (t) => ({ ...t, status: "done" }));
      await deps.state.updateTask(runId, "T2", (t) => ({
        ...t,
        status: "failed",
        failure_class: "capability-budget",
        failure_reason: "test seed",
      }));

      const env = await nextTask(deps, runId);
      expect(env).toMatchObject({ kind: "finalize" });
    } finally {
      await cleanup();
    }
  });

  // Decision 34: a dependency cycle must NOT throw — the circuit breaker fails each
  // wedged task as spec-defect and returns all-terminal so the run finalizes to failed.
  it("dependency cycle (T1↔T2) → all-terminal with both tasks spec-defect failed", async () => {
    // Pathological DAG: T1 executing with depends_on [T2], T2 pending depends_on [T1]
    // This bypasses seeding via direct state writes.
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
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

      const env = await nextTask(deps, runId);
      expect(env.kind).toBe("finalize");
      if (env.kind !== "finalize") return;
      expect(env.cascade_failed.slice().sort()).toEqual(["T1", "T2"]);

      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.status).toBe("failed");
      expect(run.tasks["T1"]?.failure_class).toBe("spec-defect");
      expect(run.tasks["T2"]?.status).toBe("failed");
      expect(run.tasks["T2"]?.failure_class).toBe("spec-defect");
    } finally {
      await cleanup();
    }
  });

  it("terminal run + quota-breach → run-terminal (no checkpoint written)", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      usage: PAUSE_5H,
      runStatusOverride: "completed",
    });
    try {
      const env = await nextTask(deps, runId);
      expect(env).toMatchObject({ kind: "done", run_status: "completed" });
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
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["only one"] }],
      usage: PAUSE_5H,
    });
    try {
      // Seed T1 as done so the run is effectively finished
      await deps.state.updateTask(runId, "T1", (t) => ({ ...t, status: "done" }));

      const env = await nextTask(deps, runId);
      expect(env).toMatchObject({ kind: "finalize", cascade_failed: [] });
      // The quota gate must NOT have run — run stays running with no checkpoint
      const run = await deps.state.read(runId);
      expect(run.status).toBe("running");
      expect(run.quota).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  // I1 pin: cascade that resolves the run to all-terminal carries the failed ids.
  it("cascade resolving run to all-terminal → all-terminal with cascade_failed", async () => {
    // T1 failed; T2 pending depends_on [T1] — cascade fails T2, run is all-terminal.
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      tasks: [
        { task_id: "T1", acceptance_criteria: ["only one"] },
        { task_id: "T2", acceptance_criteria: ["only one"], depends_on: ["T1"] },
      ],
    });
    try {
      await deps.state.updateTask(runId, "T1", (t) => ({
        ...t,
        status: "failed",
        failure_class: "capability-budget",
        failure_reason: "test seed",
      }));

      const env = await nextTask(deps, runId);
      expect(env).toMatchObject({ kind: "finalize", cascade_failed: ["T2"] });
    } finally {
      await cleanup();
    }
  });

  // Suspended recovery: a suspended run with a 7d checkpoint resumes cleanly.
  it("suspended run (7d checkpoint) is returned to running before reporting ready tasks", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["only one"] }],
    });
    try {
      await deps.state.update(runId, (s) => ({
        ...s,
        status: "suspended" as const,
        quota: { binding_window: "7d" as const, resets_at_epoch: 1_700_018_000 },
      }));
      const env = await nextTask(deps, runId);
      expect(env.kind).toBe("work");
      const run = await deps.state.read(runId);
      expect(run.status).toBe("running");
      expect(run.quota).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  // Empty run (tasks: {}) → all-terminal with empty cascade_failed.
  it("empty run (no tasks) → all-terminal with cascade_failed []", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      // Clear the default T1 so the run has zero tasks
      await deps.state.update(runId, (s) => ({ ...s, tasks: {} }));

      const env = await nextTask(deps, runId);
      expect(env).toMatchObject({ kind: "finalize", cascade_failed: [] });
    } finally {
      await cleanup();
    }
  });

  // Empty run + quota breach → all-terminal pre-gate (vacuously finished; e.g. a
  // crash between state.create and task seeding). The gate must NOT run — the
  // step-2 and step-6 all-terminal semantics agree on tasks: {}.
  it("empty run + quota-breach → all-terminal with no checkpoint written", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({ usage: PAUSE_5H });
    try {
      await deps.state.update(runId, (s) => ({ ...s, tasks: {} }));

      const env = await nextTask(deps, runId);
      expect(env).toMatchObject({ kind: "finalize", cascade_failed: [] });
      const run = await deps.state.read(runId);
      expect(run.status).toBe("running");
      expect(run.quota).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  // Decision 34: self-dependency (T1→T1) is also a wedged/cycle state — the circuit
  // breaker fails T1 as spec-defect and returns all-terminal.
  it("self-dependency (T1 depends_on T1) → all-terminal with T1 spec-defect failed", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["only one"] }],
    });
    try {
      // Inject the self-dep directly, bypassing normal seeding
      await deps.state.updateTask(runId, "T1", (t) => ({
        ...t,
        depends_on: ["T1"],
      }));

      const env = await nextTask(deps, runId);
      expect(env.kind).toBe("finalize");
      if (env.kind !== "finalize") return;
      expect(env.cascade_failed).toContain("T1");

      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.status).toBe("failed");
      expect(run.tasks["T1"]?.failure_class).toBe("spec-defect");
    } finally {
      await cleanup();
    }
  });

  // WS4 run-level circuit breaker: capability-budget fails at the cap abort the run —
  // every remaining runnable task is failed and the run finalizes (all-terminal → failed).
  it("circuit breaker: capability-budget fails at the cap abort runnable work → all-terminal", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      tasks: [
        { task_id: "T1", acceptance_criteria: ["only one"] },
        { task_id: "T2", acceptance_criteria: ["only one"] },
        { task_id: "T3", acceptance_criteria: ["only one"] },
        { task_id: "T4", acceptance_criteria: ["only one"] }, // independent, runnable
      ],
    });
    try {
      for (const id of ["T1", "T2", "T3"]) {
        await deps.state.updateTask(runId, id, (t) => ({
          ...t,
          status: "failed",
          failure_class: "capability-budget",
          failure_reason: "test seed",
        }));
      }

      const env = await nextTask(deps, runId);
      expect(env.kind).toBe("finalize");
      if (env.kind !== "finalize") return;
      expect(env.cascade_failed).toContain("T4");

      const run = await deps.state.read(runId);
      expect(run.tasks["T4"]?.status).toBe("failed");
      expect(run.tasks["T4"]?.failure_class).toBe("capability-budget");
      expect(run.tasks["T4"]?.failure_reason).toMatch(/circuit breaker tripped/);
    } finally {
      await cleanup();
    }
  });

  // Below the cap the breaker stays silent — an independent ready task is still
  // scheduled (the breaker must not abort runnable work prematurely).
  it("circuit breaker: below the cap does not abort — ready task still scheduled", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      tasks: [
        { task_id: "T1", acceptance_criteria: ["only one"] },
        { task_id: "T2", acceptance_criteria: ["only one"] },
        { task_id: "T3", acceptance_criteria: ["only one"] }, // independent, runnable
      ],
    });
    try {
      for (const id of ["T1", "T2"]) {
        await deps.state.updateTask(runId, id, (t) => ({
          ...t,
          status: "failed",
          failure_class: "capability-budget",
          failure_reason: "test seed",
        }));
      }

      const env = await nextTask(deps, runId);
      expect(env).toMatchObject({ kind: "work", ready: ["T3"] });
    } finally {
      await cleanup();
    }
  });
});

describe("docs-ready gate", () => {
  const DONE_AT = "2026-01-01T00:00:00.000Z";

  it("completed + docs applicable + docs not done → docs-ready", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1" }],
      docsApplicable: true,
    });
    try {
      await state.updateTask(runId, "T1", (t) => ({ ...t, status: "done", ended_at: DONE_AT }));
      expect((await nextTask(deps, runId)).kind).toBe("document");
    } finally {
      await cleanup();
    }
  });

  it("completed + docs NOT applicable → all-terminal", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1" }],
      docsApplicable: false,
    });
    try {
      await state.updateTask(runId, "T1", (t) => ({ ...t, status: "done", ended_at: DONE_AT }));
      expect((await nextTask(deps, runId)).kind).toBe("finalize");
    } finally {
      await cleanup();
    }
  });

  it("completed + docs already done → all-terminal", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1" }],
      docsApplicable: true,
    });
    try {
      await state.updateTask(runId, "T1", (t) => ({ ...t, status: "done", ended_at: DONE_AT }));
      await state.update(runId, (s) => ({ ...s, docs: { status: "done", ended_at: DONE_AT } }));
      expect((await nextTask(deps, runId)).kind).toBe("finalize");
    } finally {
      await cleanup();
    }
  });

  it("failed run (a failed task) → all-terminal, never docs-ready", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1" }],
      docsApplicable: true,
    });
    try {
      await state.updateTask(runId, "T1", (t) => ({
        ...t,
        status: "failed",
        failure_class: "spec-defect",
        failure_reason: "x",
        ended_at: DONE_AT,
      }));
      expect((await nextTask(deps, runId)).kind).toBe("finalize");
    } finally {
      await cleanup();
    }
  });

  it("docs-suspended run resumes through the gate to docs-ready (status cleared to running)", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1" }],
      docsApplicable: true,
    });
    try {
      await state.updateTask(runId, "T1", (t) => ({ ...t, status: "done", ended_at: DONE_AT }));
      // Seed a real quota checkpoint so the quota-cleared assertion discriminates
      // (rather than being vacuously true).
      await state.update(runId, (s) => ({
        ...s,
        status: "suspended",
        quota: { binding_window: "5h" as const, resets_at_epoch: 1_700_018_000 },
        docs: { status: "failed", reason: "prior", ended_at: DONE_AT },
      }));
      expect((await nextTask(deps, runId)).kind).toBe("document");
      const resumed = await state.read(runId);
      expect(resumed.status).toBe("running");
      // the checkpoint clear that returned the run to running must also drop quota
      expect(resumed.quota).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe("e2e-ready gate (Decision 39)", () => {
  const DONE_AT = "2026-01-01T00:00:00.000Z";

  it("completed + e2e opted-in + phase not yet run → e2e-ready", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1" }],
    });
    try {
      await state.updateTask(runId, "T1", (t) => ({ ...t, status: "done", ended_at: DONE_AT }));
      await state.update(runId, (s) => ({ ...s, e2e: true }));
      expect((await nextTask(deps, runId)).kind).toBe("e2e");
    } finally {
      await cleanup();
    }
  });

  it("completed + e2e NOT opted-in → falls straight through to finalize (no e2e gate)", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1" }],
    });
    try {
      await state.updateTask(runId, "T1", (t) => ({ ...t, status: "done", ended_at: DONE_AT }));
      expect((await nextTask(deps, runId)).kind).toBe("finalize");
    } finally {
      await cleanup();
    }
  });

  it("completed + e2e phase already done → skips e2e, proceeds to finalize", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1" }],
    });
    try {
      await state.updateTask(runId, "T1", (t) => ({ ...t, status: "done", ended_at: DONE_AT }));
      await state.update(runId, (s) => ({
        ...s,
        e2e: true,
        e2e_phase: { status: "done", manifest: [], reopen_counts: {}, ended_at: DONE_AT },
      }));
      expect((await nextTask(deps, runId)).kind).toBe("finalize");
    } finally {
      await cleanup();
    }
  });

  it("completed + e2e phase failed → finalize directly, never re-enters e2e", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1" }],
    });
    try {
      await state.updateTask(runId, "T1", (t) => ({ ...t, status: "done", ended_at: DONE_AT }));
      await state.update(runId, (s) => ({
        ...s,
        e2e: true,
        e2e_phase: {
          status: "failed",
          reason: "checkout: cap-exhausted critical",
          manifest: [],
          reopen_counts: {},
          ended_at: DONE_AT,
        },
      }));
      expect((await nextTask(deps, runId)).kind).toBe("finalize");
    } finally {
      await cleanup();
    }
  });

  it("e2e precedes docs — a docs-applicable run with e2e still pending gets e2e, not document", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1" }],
      docsApplicable: true,
    });
    try {
      await state.updateTask(runId, "T1", (t) => ({ ...t, status: "done", ended_at: DONE_AT }));
      await state.update(runId, (s) => ({ ...s, e2e: true }));
      expect((await nextTask(deps, runId)).kind).toBe("e2e");
    } finally {
      await cleanup();
    }
  });

  it("a failed e2e phase skips docs too — finalize, not document, even when docs is applicable", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1" }],
      docsApplicable: true,
    });
    try {
      await state.updateTask(runId, "T1", (t) => ({ ...t, status: "done", ended_at: DONE_AT }));
      await state.update(runId, (s) => ({
        ...s,
        e2e: true,
        e2e_phase: {
          status: "failed",
          reason: "unmappable critical regression",
          manifest: [],
          reopen_counts: {},
          ended_at: DONE_AT,
        },
      }));
      expect((await nextTask(deps, runId)).kind).toBe("finalize");
    } finally {
      await cleanup();
    }
  });

  it("e2e-cleared-for-reopen run resumes through the quota gate back to e2e (status cleared to running)", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1" }],
    });
    try {
      await state.updateTask(runId, "T1", (t) => ({ ...t, status: "done", ended_at: DONE_AT }));
      // e2e_phase.status absent = cleared for a reopen re-fire (manifest/counts persist).
      await state.update(runId, (s) => ({
        ...s,
        e2e: true,
        status: "suspended",
        quota: { binding_window: "5h" as const, resets_at_epoch: 1_700_018_000 },
        e2e_phase: {
          manifest: [{ task_ids: ["T1"], spec_path: "e2e/x.spec.ts", kind: "critical" }],
          reopen_counts: { T1: 1 },
        },
      }));
      expect((await nextTask(deps, runId)).kind).toBe("e2e");
      const resumed = await state.read(runId);
      expect(resumed.status).toBe("running");
      expect(resumed.quota).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe("docs ordering invariant", () => {
  const DONE_AT = "2026-01-01T00:00:00.000Z";

  it("docs-ready precedes all-terminal; all-terminal only after docs done", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1" }],
      docsApplicable: true,
    });
    try {
      await state.updateTask(runId, "T1", (t) => ({ ...t, status: "done", ended_at: DONE_AT }));

      // Before docs: the gate withholds all-terminal.
      expect((await nextTask(deps, runId)).kind).toBe("document");

      // Simulate the record marking docs done (Task 5's done path).
      await state.update(runId, (s) => ({ ...s, docs: { status: "done", ended_at: DONE_AT } }));

      // Now finalize is reachable.
      expect((await nextTask(deps, runId)).kind).toBe("finalize");
    } finally {
      await cleanup();
    }
  });
});
