/**
 * Unit tests for applyCircuitBreaker — the driver-layer wiring of the pure breaker.
 *
 * Focus: the DERIVATION the gate owns (the pure predicate's thresholds are already
 * covered in quota/circuit-breaker.test.ts). Namely:
 *   - failure-count arm counts ONLY capability-budget drops (both modes), excluding
 *     blocked-environmental cascades and spec-defect wedges;
 *   - the runtime arm is armed in workflow mode and disarmed in session mode.
 *
 * Uses makeCoroutineDeps (a real StateManager); `deps` is a plain object so `now`
 * can be spread-overridden, and `started_at` is set via state.update.
 */
import { describe, expect, it } from "vitest";

import { applyCircuitBreaker } from "./circuit-breaker-gate.js";
import { makeCoroutineDeps, NOW } from "./coroutine-fixtures.js";
import { epochToIso } from "../shared/time.js";
import type { FailureClass } from "../types/index.js";

/** Seed `task_id` as a classified drop (mirrors the WS1 dropped-task invariant). */
async function drop(
  state: Awaited<ReturnType<typeof makeCoroutineDeps>>["state"],
  runId: string,
  taskId: string,
  failureClass: FailureClass,
): Promise<void> {
  await state.updateTask(runId, taskId, (t) => ({
    ...t,
    status: "dropped",
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
  it("trips at the cap of capability-budget drops (session mode)", async () => {
    const { deps, runId, state, cleanup } = await makeCoroutineDeps({ tasks: FOUR });
    try {
      await drop(state, runId, "T1", "capability-budget");
      await drop(state, runId, "T2", "capability-budget");
      await drop(state, runId, "T3", "capability-budget");
      const v = await applyCircuitBreaker(deps, runId);
      expect(v?.tripped).toBe(true);
      if (v) expect(v.reason).toMatch(/consecutive failures/);
    } finally {
      await cleanup();
    }
  });

  it("trips at the cap of capability-budget drops (workflow mode)", async () => {
    const { deps, runId, state, cleanup } = await makeCoroutineDeps({
      tasks: FOUR,
      modeOverride: "workflow",
    });
    try {
      await drop(state, runId, "T1", "capability-budget");
      await drop(state, runId, "T2", "capability-budget");
      await drop(state, runId, "T3", "capability-budget");
      const v = await applyCircuitBreaker(deps, runId);
      expect(v?.tripped).toBe(true);
      if (v) expect(v.reason).toMatch(/consecutive failures/);
    } finally {
      await cleanup();
    }
  });

  it("does NOT count blocked-environmental cascades (dependency consequences)", async () => {
    const { deps, runId, state, cleanup } = await makeCoroutineDeps({ tasks: FOUR });
    try {
      await drop(state, runId, "T1", "blocked-environmental");
      await drop(state, runId, "T2", "blocked-environmental");
      await drop(state, runId, "T3", "blocked-environmental");
      await drop(state, runId, "T4", "blocked-environmental");
      expect(await applyCircuitBreaker(deps, runId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("does NOT count spec-defect wedge drops", async () => {
    const { deps, runId, state, cleanup } = await makeCoroutineDeps({ tasks: FOUR });
    try {
      await drop(state, runId, "T1", "spec-defect");
      await drop(state, runId, "T2", "spec-defect");
      await drop(state, runId, "T3", "spec-defect");
      expect(await applyCircuitBreaker(deps, runId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("one real failure cascading to two dependents does NOT trip (2 < cap of 3 genuine)", async () => {
    // The exact false-trip this derivation prevents: 1 capability-budget + cascades.
    const { deps, runId, state, cleanup } = await makeCoroutineDeps({ tasks: FOUR });
    try {
      await drop(state, runId, "T1", "capability-budget"); // the one real failure
      await drop(state, runId, "T2", "blocked-environmental"); // cascade
      await drop(state, runId, "T3", "blocked-environmental"); // cascade
      // Even a second genuine failure stays under the cap (2 < 3).
      await drop(state, runId, "T4", "capability-budget");
      expect(await applyCircuitBreaker(deps, runId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("a healthy run does not trip", async () => {
    const { deps, runId, cleanup } = await makeCoroutineDeps();
    try {
      expect(await applyCircuitBreaker(deps, runId)).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe("applyCircuitBreaker — runtime arm (workflow-armed, session-disarmed)", () => {
  it("trips in workflow mode when wall-time reaches the runtime cap", async () => {
    const { deps, runId, state, cleanup } = await makeCoroutineDeps({
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
    const { deps, runId, state, cleanup } = await makeCoroutineDeps(); // session (default)
    try {
      await state.update(runId, (s) => ({ ...s, started_at: epochToIso(NOW - 480 * 60) }));
      expect(await applyCircuitBreaker(deps, runId)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("does NOT trip in workflow mode just under the runtime cap", async () => {
    const { deps, runId, state, cleanup } = await makeCoroutineDeps({
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
