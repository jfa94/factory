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

describe("decideStop — workflow mode (prong a) → allow", () => {
  it("workflow-mode run with pending work → allow (the Workflow drives, not the session)", () => {
    // This is the headline false-block fix: a live workflow-mode run must NOT block
    // the interactive session's stop, because the background Workflow owns
    // continuation + finalize-on-stop. Without this, the session is told to
    // hand-run `factory next`/`drive`, which is actively wrong in workflow mode.
    const action = decideStop(
      run({ mode: "workflow" }, { t1: task({ status: "executing" }) }),
      false,
    );
    expect(action).toEqual({ kind: "allow" });
  });

  it("workflow-mode run with zero tasks (setup unfinished) → allow", () => {
    expect(decideStop(run({ mode: "workflow" }, {}), false)).toEqual({ kind: "allow" });
  });

  it("workflow-mode all-terminal run → allow (the Workflow finalizes, not the Stop hook)", () => {
    // In workflow mode the session must not finalize-on-stop either; the Workflow
    // returns all-terminal and the launching command runs `factory run finalize`.
    const action = decideStop(
      run({ mode: "workflow" }, { a: task({ task_id: "a", status: "done" }) }),
      false,
    );
    expect(action).toEqual({ kind: "allow" });
  });

  it("session-mode run is unaffected by the workflow prong (still blocks)", () => {
    const action = decideStop(
      run({ mode: "session" }, { t1: task({ status: "executing" }) }),
      false,
    );
    expect(action.kind).toBe("block");
  });
});

describe("decideStop — session-ownership (prong b)", () => {
  const OWNER = "session-owner-abc";

  it("owner known + stopping session != owner → allow (unrelated session, session-scoped)", () => {
    const action = decideStop(
      run({ mode: "session", owner_session: OWNER }, { t1: task({ status: "executing" }) }),
      false,
      "some-other-session",
    );
    expect(action).toEqual({ kind: "allow" });
  });

  it("owner known + stopping session == owner + pending work → block (the real owner)", () => {
    const action = decideStop(
      run({ mode: "session", owner_session: OWNER }, { t1: task({ status: "executing" }) }),
      false,
      OWNER,
    );
    expect(action.kind).toBe("block");
  });

  it("owner known + stopping session == owner + all-terminal → finalize (the real owner)", () => {
    const action = decideStop(
      run({ mode: "session", owner_session: OWNER }, { a: task({ task_id: "a", status: "done" }) }),
      false,
      OWNER,
    );
    expect(action).toEqual({ kind: "finalize", status: "completed" });
  });

  it("owner UNKNOWN (not stamped) → fall back to blocking the stopping session (degraded but safe)", () => {
    // When the owner could not be stamped at create, we cannot session-scope; the
    // safe default is to preserve the current behavior (block the stopping session
    // with pending work) so a real owner is never let go silently.
    const action = decideStop(
      run({ mode: "session" }, { t1: task({ status: "executing" }) }),
      false,
      "any-session",
    );
    expect(action.kind).toBe("block");
  });

  it("owner known but stopping session UNKNOWN (no stdin) → block (cannot prove non-owner)", () => {
    // If we can't read the stopping session id we cannot prove it is NOT the owner;
    // fail safe by keeping the existing block behavior for a pending run.
    const action = decideStop(
      run({ mode: "session", owner_session: OWNER }, { t1: task({ status: "executing" }) }),
      false,
      undefined,
    );
    expect(action.kind).toBe("block");
  });
});

describe("decideStop — live run with pending work → block", () => {
  it("blocks when a task is in-flight (reason names the task)", () => {
    const action = decideStop(run({}, { t1: task({ task_id: "t1", status: "executing" }) }), false);
    expect(action.kind).toBe("block");
    expect((action as Extract<StopAction, { kind: "block" }>).reason).toContain("t1=executing");
    expect((action as Extract<StopAction, { kind: "block" }>).reason).toContain(
      "FACTORY_ALLOW_STOP",
    );
    // guidance must name the coroutine seam, not deleted run-task
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

  it("mix of done + dropped → finalize failed (Decision 34: no partial rollup)", () => {
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
    expect(action).toEqual({ kind: "finalize", status: "failed" });
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

  // The Stop hook reads its stdin to extract the stopping session_id. Tests that
  // exercise NON-session-scoping behavior inject an empty payload (unknown stopping
  // session) so they neither hang on real process.stdin nor accidentally session-scope.
  const emptyStdin = async () => "";

  it("no active run → OK, emits nothing", async () => {
    const { out, emit } = emitter();
    const manager = {
      findActiveByOwner: async () => null,
      readCurrent: async () => null,
      finalize: vi.fn(),
    };
    const code = await runStopGate([], { manager, emit, allowStop: false, readRaw: emptyStdin });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]);
    expect(manager.finalize).not.toHaveBeenCalled();
  });

  it("pending work → emits {decision:block} on stdout, OK", async () => {
    const { out, emit } = emitter();
    const manager = {
      findActiveByOwner: async () => null,
      readCurrent: async () => run({}, { t1: task({ status: "executing" }) }),
      finalize: vi.fn(),
    };
    const code = await runStopGate([], { manager, emit, allowStop: false, readRaw: emptyStdin });
    expect(code).toBe(EXIT.OK);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ decision: "block" });
    expect(manager.finalize).not.toHaveBeenCalled();
  });

  it("all-terminal run → finalizes to the derived status, OK, no block", async () => {
    const { out, emit } = emitter();
    const finalize = vi.fn(async () => run({ status: "completed" }));
    const manager = {
      findActiveByOwner: async () => null,
      readCurrent: async () => run({}, { a: task({ task_id: "a", status: "done" }) }),
      finalize,
    };
    const code = await runStopGate([], { manager, emit, allowStop: false, readRaw: emptyStdin });
    expect(code).toBe(EXIT.OK);
    expect(finalize).toHaveBeenCalledWith("run-x", "completed");
    expect(out).toEqual([]);
  });

  it("finalize failure → blocks (surface inconsistency), OK", async () => {
    const { out, emit } = emitter();
    const manager = {
      findActiveByOwner: async () => null,
      readCurrent: async () => run({}, { a: task({ task_id: "a", status: "done" }) }),
      finalize: vi.fn(async () => {
        throw new Error("disk full");
      }),
    };
    const code = await runStopGate([], { manager, emit, allowStop: false, readRaw: emptyStdin });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out[0]!)).toMatchObject({ decision: "block" });
    expect(out[0]!).toContain("finalize-on-stop failed");
  });

  it("unreadable current state → blocks (never silently stop on corruption)", async () => {
    const { out, emit } = emitter();
    const manager = {
      findActiveByOwner: async () => null,
      readCurrent: async () => {
        throw new Error("invalid json");
      },
      finalize: vi.fn(),
    };
    const code = await runStopGate([], { manager, emit, allowStop: false, readRaw: emptyStdin });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out[0]!)).toMatchObject({ decision: "block" });
    expect(out[0]!).toContain("pipeline state unreadable");
    expect(manager.finalize).not.toHaveBeenCalled();
  });

  it("workflow-mode run → allow, emits nothing, no finalize (session is not the driver)", async () => {
    const { out, emit } = emitter();
    const finalize = vi.fn();
    const manager = {
      findActiveByOwner: async () => null,
      readCurrent: async () => run({ mode: "workflow" }, { t1: task({ status: "executing" }) }),
      finalize,
    };
    const code = await runStopGate([], { manager, emit, allowStop: false, readRaw: emptyStdin });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("reads the stopping session_id from stdin → unrelated session passes through", async () => {
    const { out, emit } = emitter();
    const finalize = vi.fn();
    const owner1 = run(
      { mode: "session", owner_session: "owner-1" },
      { t1: task({ status: "executing" }) },
    );
    const manager = {
      // intruder-9 owns nothing; the global pointer's run is stamped to owner-1 →
      // not adopted by the intruder → pass through.
      findActiveByOwner: async (_s: string) => null,
      readCurrent: async () => owner1,
      finalize,
    };
    const readRaw = async () =>
      JSON.stringify({ session_id: "intruder-9", hook_event_name: "Stop" });
    const code = await runStopGate([], { manager, emit, allowStop: false, readRaw });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]); // allow: a different session must not be blocked
    expect(finalize).not.toHaveBeenCalled();
  });

  it("stdin session_id == owner → still blocks the owning session with pending work", async () => {
    const { out, emit } = emitter();
    const owner1 = run(
      { mode: "session", owner_session: "owner-1" },
      { t1: task({ status: "executing" }) },
    );
    const manager = {
      findActiveByOwner: async (s: string) => (s === "owner-1" ? owner1 : null),
      readCurrent: async () => owner1,
      finalize: vi.fn(),
    };
    const readRaw = async () => JSON.stringify({ session_id: "owner-1", hook_event_name: "Stop" });
    const code = await runStopGate([], { manager, emit, allowStop: false, readRaw });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out[0]!)).toMatchObject({ decision: "block" });
  });

  it("CLOBBER FIX: finalizes the run the STOPPING session owns, not runs/current", async () => {
    // The bug: runs/current was repointed to another session's run-B; the owner of
    // run-A (all tasks done) reads `current` → run-B (owner-B, still live) → prong-b
    // ALLOW → run-A dangles `running`. Owner-scoped resolution finalizes run-A.
    const { out, emit } = emitter();
    const runA = run(
      { run_id: "run-A", mode: "session", owner_session: "sess-A" },
      { a: task({ task_id: "a", status: "done" }) },
    );
    const runB = run(
      { run_id: "run-B", mode: "session", owner_session: "sess-B" },
      { b: task({ task_id: "b", status: "executing" }) },
    );
    const finalize = vi.fn(async () => run({ status: "completed" }));
    const manager = {
      findActiveByOwner: async (s: string) =>
        s === "sess-A" ? runA : s === "sess-B" ? runB : null,
      readCurrent: async () => runB, // the clobbered global pointer
      finalize,
    };
    const readRaw = async () => JSON.stringify({ session_id: "sess-A", hook_event_name: "Stop" });
    const code = await runStopGate([], { manager, emit, allowStop: false, readRaw });
    expect(code).toBe(EXIT.OK);
    expect(finalize).toHaveBeenCalledWith("run-A", "completed"); // NOT run-B
    expect(out).toEqual([]);
  });

  it("known stopper owning no run + UN-stamped current → adopts it (degraded-safe block)", async () => {
    // Preserves the decideStop "owner unknown → block" contract: when the global
    // run carries no owner_session we cannot prove the stopper is not its owner.
    const { out, emit } = emitter();
    const unstamped = run({ mode: "session" }, { t1: task({ status: "executing" }) });
    const manager = {
      findActiveByOwner: async (_s: string) => null,
      readCurrent: async () => unstamped,
      finalize: vi.fn(),
    };
    const readRaw = async () => JSON.stringify({ session_id: "sess-A", hook_event_name: "Stop" });
    const code = await runStopGate([], { manager, emit, allowStop: false, readRaw });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out[0]!)).toMatchObject({ decision: "block" });
  });

  it("known stopper owning no run + current owned by a DIFFERENT session → pass through", async () => {
    const { out, emit } = emitter();
    const otherOwner = run(
      { mode: "session", owner_session: "sess-B" },
      { t1: task({ status: "executing" }) },
    );
    const finalize = vi.fn();
    const manager = {
      findActiveByOwner: async (_s: string) => null,
      readCurrent: async () => otherOwner, // a DIFFERENT known owner's run
      finalize,
    };
    const readRaw = async () => JSON.stringify({ session_id: "sess-A", hook_event_name: "Stop" });
    const code = await runStopGate([], { manager, emit, allowStop: false, readRaw });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]); // not ours → never block/finalize another session's run
    expect(finalize).not.toHaveBeenCalled();
  });

  it("malformed stdin → treats stopping session as unknown (degraded-safe, still blocks owner-or-unknown)", async () => {
    const { out, emit } = emitter();
    const manager = {
      findActiveByOwner: async () => null,
      readCurrent: async () =>
        run({ mode: "session", owner_session: "owner-1" }, { t1: task({ status: "executing" }) }),
      finalize: vi.fn(),
    };
    const readRaw = async () => "}{ not json";
    const code = await runStopGate([], { manager, emit, allowStop: false, readRaw });
    expect(code).toBe(EXIT.OK);
    // unknown stopping session vs known owner → cannot prove non-owner → block.
    expect(JSON.parse(out[0]!)).toMatchObject({ decision: "block" });
  });
});
