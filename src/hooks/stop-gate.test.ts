/**
 * WS9/WS10 — Stop hook tests.
 *
 * decideStop is pure: null/terminal/paused/suspended pass through; a live run with
 * pending work blocks (unless FACTORY_ALLOW_STOP); a live run whose tasks are all
 * terminal finalizes to the decideFinalize status. runStopGate wires that to the
 * StateManager + the {decision:"block"} stdout contract; finalize/read failures
 * block (never a silent corrupt-state stop).
 */
import { describe, it, expect, vi } from "vitest";
import { decideStop, runStopGate, type StopAction } from "./stop-gate.js";
import { EXIT } from "../cli/exit-codes.js";
import type { RunState, TaskState } from "../types/index.js";

const SPEC = { repo: "o/n", spec_id: "1-x", issue_number: 1 } as const;

function task(over: Partial<TaskState> = {}): TaskState {
  return {
    task_id: "t1",
    status: "executing",
    depends_on: [],
    risk_tier: "low",
    escalation_rung: 0,
    reviewers: [],
    ...over,
  } as TaskState;
}

function run(over: Partial<RunState> = {}, tasks: Record<string, TaskState> = {}): RunState {
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
    ...over,
  } as RunState;
}

describe("decideStop — pass-through statuses", () => {
  it("no active run → allow", () => {
    expect(decideStop(null, false)).toEqual({ kind: "allow" });
  });

  it.each(["completed", "partial", "failed", "paused", "suspended"] as const)(
    "non-running status '%s' → allow (intentional)",
    (status) => {
      expect(decideStop(run({ status }), false)).toEqual({ kind: "allow" });
    },
  );
});

describe("decideStop — live run with pending work → block", () => {
  it("blocks when a task is in-flight (reason names the task)", () => {
    const action = decideStop(run({}, { t1: task({ task_id: "t1", status: "executing" }) }), false);
    expect(action.kind).toBe("block");
    expect((action as Extract<StopAction, { kind: "block" }>).reason).toContain("t1=executing");
    expect((action as Extract<StopAction, { kind: "block" }>).reason).toContain(
      "FACTORY_ALLOW_STOP",
    );
    // guidance must name the pump seam, not deleted run-task
    expect((action as Extract<StopAction, { kind: "block" }>).reason).toMatch(/factory next --run/);
  });

  it("blocks when setup is unfinished (zero tasks)", () => {
    const action = decideStop(run({}, {}), false);
    expect(action.kind).toBe("block");
    expect((action as Extract<StopAction, { kind: "block" }>).reason).toContain(
      "spec/tasks not yet populated",
    );
  });

  it("escape hatch (allowStop) → allow even with pending work", () => {
    expect(decideStop(run({}, { t1: task({ status: "executing" }) }), true)).toEqual({
      kind: "allow",
    });
    expect(decideStop(run({}, {}), true)).toEqual({ kind: "allow" });
  });
});

describe("decideStop — live run, all tasks terminal → finalize", () => {
  it("every task done → finalize completed", () => {
    const action = decideStop(
      run(
        {},
        { a: task({ task_id: "a", status: "done" }), b: task({ task_id: "b", status: "done" }) },
      ),
      false,
    );
    expect(action).toEqual({ kind: "finalize", status: "completed" });
  });

  it("mix of done + dropped → finalize partial", () => {
    const action = decideStop(
      run(
        {},
        {
          a: task({ task_id: "a", status: "done" }),
          b: task({ task_id: "b", status: "dropped", failure_class: "capability-budget" }),
        },
      ),
      false,
    );
    expect(action).toEqual({ kind: "finalize", status: "partial" });
  });

  it("all dropped (zero done) → finalize failed", () => {
    const action = decideStop(
      run({}, { a: task({ task_id: "a", status: "dropped", failure_class: "spec-defect" }) }),
      false,
    );
    expect(action).toEqual({ kind: "finalize", status: "failed" });
  });

  it("escape hatch does NOT short-circuit a clean finalize", () => {
    // allowStop only matters when work is pending; all-terminal still finalizes.
    const action = decideStop(run({}, { a: task({ task_id: "a", status: "done" }) }), true);
    expect(action).toEqual({ kind: "finalize", status: "completed" });
  });
});

describe("runStopGate — I/O wiring", () => {
  function emitter() {
    const out: string[] = [];
    return { out, emit: (s: string) => out.push(s) };
  }

  it("no active run → OK, emits nothing", async () => {
    const { out, emit } = emitter();
    const manager = { readCurrent: async () => null, finalize: vi.fn() };
    const code = await runStopGate([], { manager, emit, allowStop: false });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]);
    expect(manager.finalize).not.toHaveBeenCalled();
  });

  it("pending work → emits {decision:block} on stdout, OK", async () => {
    const { out, emit } = emitter();
    const manager = {
      readCurrent: async () => run({}, { t1: task({ status: "executing" }) }),
      finalize: vi.fn(),
    };
    const code = await runStopGate([], { manager, emit, allowStop: false });
    expect(code).toBe(EXIT.OK);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ decision: "block" });
    expect(manager.finalize).not.toHaveBeenCalled();
  });

  it("all-terminal run → finalizes to the derived status, OK, no block", async () => {
    const { out, emit } = emitter();
    const finalize = vi.fn(async () => run({ status: "completed" }));
    const manager = {
      readCurrent: async () => run({}, { a: task({ task_id: "a", status: "done" }) }),
      finalize,
    };
    const code = await runStopGate([], { manager, emit, allowStop: false });
    expect(code).toBe(EXIT.OK);
    expect(finalize).toHaveBeenCalledWith("run-x", "completed");
    expect(out).toEqual([]);
  });

  it("finalize failure → blocks (surface inconsistency), OK", async () => {
    const { out, emit } = emitter();
    const manager = {
      readCurrent: async () => run({}, { a: task({ task_id: "a", status: "done" }) }),
      finalize: vi.fn(async () => {
        throw new Error("disk full");
      }),
    };
    const code = await runStopGate([], { manager, emit, allowStop: false });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out[0]!)).toMatchObject({ decision: "block" });
    expect(out[0]!).toContain("finalize-on-stop failed");
  });

  it("unreadable current state → blocks (never silently stop on corruption)", async () => {
    const { out, emit } = emitter();
    const manager = {
      readCurrent: async () => {
        throw new Error("invalid json");
      },
      finalize: vi.fn(),
    };
    const code = await runStopGate([], { manager, emit, allowStop: false });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out[0]!)).toMatchObject({ decision: "block" });
    expect(out[0]!).toContain("pipeline state unreadable");
    expect(manager.finalize).not.toHaveBeenCalled();
  });
});
