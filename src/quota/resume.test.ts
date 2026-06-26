import { describe, it, expect } from "vitest";
import { parseRunState, type RunState } from "../types/index.js";
import { defaultConfig } from "../config/schema.js";
import { planResume } from "./resume.js";
import { FIVE_HOUR_WINDOW_SECONDS, SEVEN_DAY_WINDOW_SECONDS } from "./window.js";
import type { UsageReading } from "./usage-source.js";

const CONFIG = defaultConfig();
const NOW = 1_700_000_000;

/**
 * A suspended run with one done task and one dropped task — committed work that
 * must NOT be disturbed by a resume.
 */
function suspendedRun(): RunState {
  return parseRunState({
    schema_version: 1,
    run_id: "run-20260604-000000",
    status: "suspended",
    execution_mode: "balanced",
    spec: { repo: "owner/name", spec_id: "12-thing", issue_number: 12 },
    tasks: {
      a: { task_id: "a", risk_tier: "low", status: "done" },
      b: {
        task_id: "b",
        risk_tier: "high",
        status: "dropped",
        failure_class: "capability-budget",
        failure_reason: "ladder exhausted",
      },
    },
    quota: { binding_window: "7d", resets_at_epoch: NOW + 100 },
    started_at: "2026-06-04T00:00:00Z",
    updated_at: "2026-06-04T00:00:00Z",
    ended_at: null,
  });
}

/** A reading where both windows have reset and util is under curve. */
function underCurveReading(): UsageReading {
  return {
    kind: "available",
    fiveHour: { utilizationPct: 1, resetsAtEpoch: NOW + FIVE_HOUR_WINDOW_SECONDS },
    sevenDay: { utilizationPct: 1, resetsAtEpoch: NOW + SEVEN_DAY_WINDOW_SECONDS },
    capturedAt: NOW,
  };
}

/** A reading where the 7d window is still over curve (day 1 cap 14). */
function stillOver7dReading(): UsageReading {
  return {
    kind: "available",
    fiveHour: { utilizationPct: 1, resetsAtEpoch: NOW + FIVE_HOUR_WINDOW_SECONDS },
    sevenDay: { utilizationPct: 90, resetsAtEpoch: NOW + SEVEN_DAY_WINDOW_SECONDS },
    capturedAt: NOW,
  };
}

describe("Δ F resume from checkpoint — under-curve reading resumes from the last committed checkpoint", () => {
  it("a suspended run + recovered usage → resume with the checkpoint-clearing patch", () => {
    const plan = planResume(suspendedRun(), underCurveReading(), CONFIG, NOW);
    expect(plan.kind).toBe("resume");
    if (plan.kind === "resume") {
      expect(plan.clear).toEqual({ status: "running", quota: undefined });
    }
  });

  it("applying the resume patch returns to running with NO committed work lost", () => {
    const run = suspendedRun();
    const plan = planResume(run, underCurveReading(), CONFIG, NOW);
    if (plan.kind !== "resume") throw new Error("expected resume");

    const resumed = parseRunState({ ...run, ...plan.clear });
    expect(resumed.status).toBe("running");
    expect(resumed.quota).toBeUndefined();
    // Committed task state is untouched: the done task stays done, the dropped
    // task stays dropped with its classification intact.
    expect(resumed.tasks.a!.status).toBe("done");
    expect(resumed.tasks.b!.status).toBe("dropped");
    expect(resumed.tasks.b!.failure_class).toBe("capability-budget");
  });
});

describe("Δ F resume from checkpoint — still-over reading stays blocked (fail-closed)", () => {
  it("a still-over 7d reading → still-blocked carrying the suspend decision", () => {
    const plan = planResume(suspendedRun(), stillOver7dReading(), CONFIG, NOW);
    expect(plan.kind).toBe("pause");
    if (plan.kind === "pause") {
      expect(plan.decision.kind).toBe("suspend-7d");
    }
  });

  it("an unavailable reading → still-blocked (never resumes blind)", () => {
    const plan = planResume(
      suspendedRun(),
      { kind: "unavailable", reason: "usage-cache-missing" },
      CONFIG,
      NOW,
    );
    expect(plan.kind).toBe("pause");
    if (plan.kind === "pause") {
      expect(plan.decision.kind).toBe("unavailable-halt");
    }
  });
});

describe("Δ F resume — ignore_quota short-circuits the live pacer check", () => {
  it("a 7d-parked run with ignore_quota=true resumes regardless of a still-over reading", () => {
    const run = parseRunState({ ...suspendedRun(), ignore_quota: true });
    const plan = planResume(run, stillOver7dReading(), CONFIG, NOW);
    expect(plan.kind).toBe("resume");
    if (plan.kind === "resume") {
      expect(plan.clear).toEqual({ status: "running", quota: undefined });
    }
  });

  it("a 7d-parked run with ignore_quota=true resumes even when usage is unavailable", () => {
    const run = parseRunState({ ...suspendedRun(), ignore_quota: true });
    const plan = planResume(
      run,
      { kind: "unavailable", reason: "usage-cache-missing" },
      CONFIG,
      NOW,
    );
    expect(plan.kind).toBe("resume");
  });

  it("ignore_quota=false (default) still fails-closed on a still-over reading", () => {
    // Belt-and-suspenders: the default field value must not accidentally bypass the gate.
    const run = parseRunState({ ...suspendedRun(), ignore_quota: false });
    const plan = planResume(run, stillOver7dReading(), CONFIG, NOW);
    expect(plan.kind).toBe("pause");
  });
});

describe("Δ F resume — non-resumable run states are reported, not resumed", () => {
  it("a running run is not resumable", () => {
    const running = parseRunState({ ...suspendedRun(), status: "running", quota: undefined });
    const plan = planResume(running, underCurveReading(), CONFIG, NOW);
    expect(plan).toEqual({ kind: "not-resumable", status: "running" });
  });

  it("a terminal (completed) run is not resumable", () => {
    const completed = parseRunState({
      ...suspendedRun(),
      status: "completed",
      quota: undefined,
      tasks: { a: { task_id: "a", risk_tier: "low", status: "done" } },
    });
    const plan = planResume(completed, underCurveReading(), CONFIG, NOW);
    expect(plan.kind).toBe("not-resumable");
  });
});
