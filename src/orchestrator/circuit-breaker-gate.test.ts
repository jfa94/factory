/**
 * Unit tests for applyCircuitBreaker — the orchestrator-layer wiring of the pure breaker.
 *
 * Focus: the DERIVATION the gate owns (the pure predicate's thresholds are already
 * covered in quota/circuit-breaker.test.ts). Namely:
 *   - failure-count arm counts ONLY capability-budget failures (both modes), excluding
 *     blocked-environmental cascades and spec-defect wedges;
 *   - the runtime arm is armed in workflow mode and disarmed in session mode.
 *
 * Uses makeOrchestratorDeps (a real StateManager); `deps` is a plain object so `now`
 * can be spread-overridden, and `started_at` is set via state.update.
 */
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { applyCircuitBreaker } from "./circuit-breaker-gate.js";
import { makeOrchestratorDeps, NOW } from "./orchestrator-fixtures.js";
import { runStatePath } from "../core/state/paths.js";
import { atomicWriteFile } from "../shared/atomic-write.js";
import { epochToIso } from "../shared/time.js";
import type { FailureClass } from "../types/index.js";

/** Seed `task_id` as a classified fail (mirrors the WS1 failed-task invariant). */
async function failTask(
  state: Awaited<ReturnType<typeof makeOrchestratorDeps>>["state"],
  runId: string,
  taskId: string,
  failureClass: FailureClass,
): Promise<void> {
  await state.updateTask(runId, taskId, (t) => ({
    ...t,
    status: "failed",
    failure_class: failureClass,
    failure_reason: `test seed (${failureClass})`,
  }));
}

const FOUR = [
  { task_id: "T1", acceptance_criteria: ["only one"] },
  { task_id: "T2", acceptance_criteria: ["only one"] },
  { task_id: "T3", acceptance_criteria: ["only one"] },
  { task_id: "T4", acceptance_criteria: ["only one"] },
];

describe("applyCircuitBreaker — failure-count arm (capability-budget only)", () => {
  it("trips at the cap of capability-budget failures (session mode)", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({ tasks: FOUR });
    try {
      await failTask(state, runId, "T1", "capability-budget");
      await failTask(state, runId, "T2", "capability-budget");
      await failTask(state, runId, "T3", "capability-budget");
      const v = await applyCircuitBreaker(deps, runId);
      expect(v?.tripped).toBe(true);
      if (v) expect(v.reason).toMatch(/cumulative failures/);
    } finally {
      await cleanup();
    }
  });

  it("trips at the cap of capability-budget failures (workflow mode)", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      tasks: FOUR,
      modeOverride: "workflow",
    });
    try {
      await failTask(state, runId, "T1", "capability-budget");
      await failTask(state, runId, "T2", "capability-budget");
      await failTask(state, runId, "T3", "capability-budget");
      const v = await applyCircuitBreaker(deps, runId);
      expect(v?.tripped).toBe(true);
      if (v) expect(v.reason).toMatch(/cumulative failures/);
    } finally {
      await cleanup();
    }
  });

  it("does NOT count blocked-environmental cascades (dependency consequences)", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({ tasks: FOUR });
    try {
      await failTask(state, runId, "T1", "blocked-environmental");
      await failTask(state, runId, "T2", "blocked-environmental");
      await failTask(state, runId, "T3", "blocked-environmental");
      await failTask(state, runId, "T4", "blocked-environmental");
      expect(await applyCircuitBreaker(deps, runId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("does NOT count spec-defect wedge failures", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({ tasks: FOUR });
    try {
      await failTask(state, runId, "T1", "spec-defect");
      await failTask(state, runId, "T2", "spec-defect");
      await failTask(state, runId, "T3", "spec-defect");
      expect(await applyCircuitBreaker(deps, runId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("one real failure cascading to two dependents does NOT trip (2 < cap of 3 genuine)", async () => {
    // The exact false-trip this derivation prevents: 1 capability-budget + cascades.
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({ tasks: FOUR });
    try {
      await failTask(state, runId, "T1", "capability-budget"); // the one real failure
      await failTask(state, runId, "T2", "blocked-environmental"); // cascade
      await failTask(state, runId, "T3", "blocked-environmental"); // cascade
      // Even a second genuine failure stays under the cap (2 < 3).
      await failTask(state, runId, "T4", "capability-budget");
      expect(await applyCircuitBreaker(deps, runId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("a healthy run does not trip", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      expect(await applyCircuitBreaker(deps, runId)).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe("applyCircuitBreaker — runtime arm (workflow-armed, session-disarmed)", () => {
  it("trips in workflow mode when wall-time reaches the runtime cap", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      modeOverride: "workflow",
    });
    try {
      // started_at = now - 480min so wall-time == the default maxRuntimeMinutes (480).
      await state.update(runId, (s) => ({ ...s, started_at: epochToIso(NOW - 480 * 60) }));
      const v = await applyCircuitBreaker(deps, runId);
      expect(v?.tripped).toBe(true);
      if (v) expect(v.reason).toMatch(/max runtime/);
    } finally {
      await cleanup();
    }
  });

  it("does NOT trip in session mode at the same wall-time (runtime arm disarmed)", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps(); // session (default)
    try {
      await state.update(runId, (s) => ({ ...s, started_at: epochToIso(NOW - 480 * 60) }));
      expect(await applyCircuitBreaker(deps, runId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("does NOT trip in workflow mode just under the runtime cap", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({
      modeOverride: "workflow",
    });
    try {
      await state.update(runId, (s) => ({ ...s, started_at: epochToIso(NOW - 479 * 60) }));
      expect(await applyCircuitBreaker(deps, runId)).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe("applyCircuitBreaker — D7: idle time never counts toward the runtime ceiling", () => {
  /**
   * Backdate timestamps on disk, bypassing StateManager.update() (which always
   * re-stamps `updated_at` and would bank the gap itself — here we need the gap
   * still PENDING when the gate evaluates, the exact first-next-task-after-a-pause
   * shape that cascade-failed the field run).
   */
  async function backdateOnDisk(
    dataDir: string,
    runId: string,
    fields: { started_at: string; updated_at: string },
  ): Promise<void> {
    const path = runStatePath(dataDir, runId);
    const onDisk = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await atomicWriteFile(path, JSON.stringify({ ...onDisk, ...fields }));
  }

  it("a running workflow run parked idle for 3 days does NOT trip (the D7 false positive)", async () => {
    const { deps, runId, dataDir, cleanup } = await makeOrchestratorDeps({
      modeOverride: "workflow",
    });
    try {
      // One write at start, then nobody drove the loop for 3 days: the whole
      // wall-clock is a pending idle gap the gate must credit before evaluating.
      const threeDaysAgo = epochToIso(NOW - 3 * 24 * 60 * 60);
      await backdateOnDisk(dataDir, runId, { started_at: threeDaysAgo, updated_at: threeDaysAgo });
      expect(await applyCircuitBreaker(deps, runId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("a genuinely ACTIVE workflow run at the cap still trips (recent write, full wall runtime)", async () => {
    const { deps, runId, dataDir, cleanup } = await makeOrchestratorDeps({
      modeOverride: "workflow",
    });
    try {
      // Last write 30min ago (sub-grace → pending credit 0), running since 480min ago.
      await backdateOnDisk(dataDir, runId, {
        started_at: epochToIso(NOW - 480 * 60),
        updated_at: epochToIso(NOW - 30 * 60),
      });
      const v = await applyCircuitBreaker(deps, runId);
      expect(v?.tripped).toBe(true);
      if (v) expect(v.reason).toMatch(/max runtime/);
    } finally {
      await cleanup();
    }
  });
});
