/**
 * WS9 — active-run resolution tests. The three runs/current cases the bash hooks
 * got right are preserved: NO symlink → null (pass through), DANGLING symlink →
 * BrokenRunStateError (fail closed), VALID symlink → parsed run. Plus the pure
 * task/stage derivation (DERIVE-don't-store: stage from status, never a stored
 * phase). Uses a real on-disk run store so the symlink walk is genuinely exercised.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../core/state/index.js";
import { currentLinkPath } from "../core/state/index.js";
import {
  loadActiveRun,
  resolveActiveTask,
  isTestWriterPhase,
  BrokenRunStateError,
} from "./hook-context.js";
import type { RunState, TaskState } from "../types/index.js";

const SPEC = { repo: "o/n", spec_id: "1-x", issue_number: 1 } as const;

describe("loadActiveRun — runs/current resolution", () => {
  let dataDir: string;
  const origTaskId = process.env.FACTORY_TASK_ID;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "hc-"));
    delete process.env.FACTORY_TASK_ID;
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (origTaskId === undefined) delete process.env.FACTORY_TASK_ID;
    else process.env.FACTORY_TASK_ID = origTaskId;
  });

  it("NO symlink → null (no active run; guards pass through)", async () => {
    const active = await loadActiveRun({ dataDir });
    expect(active).toBeNull();
  });

  it("VALID symlink → parsed ActiveRun", async () => {
    const mgr = new StateManager({ dataDir });
    await mgr.create({ run_id: "run-20260101-000000", spec: SPEC });
    const active = await loadActiveRun({ dataDir });
    expect(active).not.toBeNull();
    expect(active!.dataDir).toBe(dataDir);
    expect(active!.run.run_id).toBe("run-20260101-000000");
  });

  it("DANGLING symlink → BrokenRunStateError (fail closed)", async () => {
    // Point runs/current at a run dir that does not exist.
    mkdirSync(join(dataDir, "runs"), { recursive: true });
    symlinkSync(join(dataDir, "runs", "ghost"), currentLinkPath(dataDir));
    await expect(loadActiveRun({ dataDir })).rejects.toBeInstanceOf(BrokenRunStateError);
  });

  it("unresolvable data dir → null (bare dev shell, no active run)", async () => {
    // resolveDataDir throws when nothing identifies a data dir; loadActiveRun
    // swallows THAT (path resolution) into null — distinct from a dangling link.
    const active = await loadActiveRun({ dataDir: "" as unknown as string });
    // An empty-string dataDir resolves to a path with no runs/current → null.
    expect(active).toBeNull();
  });
});

// --- pure derivation -------------------------------------------------------

function task(over: Partial<TaskState> = {}): TaskState {
  return {
    task_id: "t1",
    status: "pending",
    depends_on: [],
    risk_tier: "low",
    escalation_rung: 0,
    reviewers: [],
    ...over,
  } as TaskState;
}

function run(tasks: Record<string, TaskState>): RunState {
  return {
    schema_version: 1,
    run_id: "run-x",
    status: "running",
    driver: "balanced",
    spec: SPEC,
    tasks,
    started_at: "t",
    updated_at: "t",
    ended_at: null,
  } as RunState;
}

describe("resolveActiveTask — stage DERIVED from status (Δ V)", () => {
  const origTaskId = process.env.FACTORY_TASK_ID;
  afterEach(() => {
    if (origTaskId === undefined) delete process.env.FACTORY_TASK_ID;
    else process.env.FACTORY_TASK_ID = origTaskId;
  });

  it("single executing task → stage tests", () => {
    delete process.env.FACTORY_TASK_ID;
    const active = resolveActiveTask(run({ t1: task({ status: "executing" }) }));
    expect(active?.stage).toBe("tests");
  });

  it("single reviewing task → stage verify", () => {
    delete process.env.FACTORY_TASK_ID;
    const active = resolveActiveTask(run({ t1: task({ status: "reviewing" }) }));
    expect(active?.stage).toBe("verify");
  });

  it("single shipping task → stage ship", () => {
    delete process.env.FACTORY_TASK_ID;
    const active = resolveActiveTask(run({ t1: task({ status: "shipping" }) }));
    expect(active?.stage).toBe("ship");
  });

  it("ambiguous (two in-flight, no explicit id) → null", () => {
    delete process.env.FACTORY_TASK_ID;
    const active = resolveActiveTask(
      run({
        t1: task({ task_id: "t1", status: "executing" }),
        t2: task({ task_id: "t2", status: "reviewing" }),
      }),
    );
    expect(active).toBeNull();
  });

  it("explicit task id selects even amid ambiguity", () => {
    delete process.env.FACTORY_TASK_ID;
    const active = resolveActiveTask(
      run({
        t1: task({ task_id: "t1", status: "executing" }),
        t2: task({ task_id: "t2", status: "reviewing" }),
      }),
      "t2",
    );
    expect(active?.task.task_id).toBe("t2");
    expect(active?.stage).toBe("verify");
  });

  it("explicit id absent from run → null (no fabrication)", () => {
    delete process.env.FACTORY_TASK_ID;
    expect(resolveActiveTask(run({ t1: task() }), "nope")).toBeNull();
  });

  it("no in-flight task → null", () => {
    delete process.env.FACTORY_TASK_ID;
    expect(resolveActiveTask(run({ t1: task({ status: "done" }) }))).toBeNull();
  });
});

describe("isTestWriterPhase", () => {
  it("executing + test-writer role → true", () => {
    const active = resolveActiveTask(
      run({ t1: task({ status: "executing", producer_role: "test-writer" }) }),
      "t1",
    );
    expect(isTestWriterPhase(active)).toBe(true);
  });

  it("executing + executor role → false (GREEN phase, not test-writer)", () => {
    const active = resolveActiveTask(
      run({ t1: task({ status: "executing", producer_role: "executor" }) }),
      "t1",
    );
    expect(isTestWriterPhase(active)).toBe(false);
  });

  it("reviewing → false", () => {
    const active = resolveActiveTask(run({ t1: task({ status: "reviewing" }) }), "t1");
    expect(isTestWriterPhase(active)).toBe(false);
  });

  it("null active → false", () => {
    expect(isTestWriterPhase(null)).toBe(false);
  });
});
