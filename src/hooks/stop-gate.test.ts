/**
 * WS9/WS10 — Stop hook tests.
 *
 * decideStop is pure and, since the session-hostage fix, only ever ALLOWS or FINALIZES:
 * null/terminal/paused/suspended pass through; workflow mode and a non-owner session pass
 * through; a live run with pending work passes through (NO block — it stays resumable); a
 * session-mode run whose tasks are all terminal finalizes to the decideFinalize status.
 * runStopGate wires that to the StateManager; the only `{decision:"block"}` outputs left are
 * the two corruption cases (unreadable state, finalize failure) — never lack of progress.
 */
import { describe, it, expect, vi } from "vitest";
import { decideStop, runStopGate } from "./stop-gate.js";
import { EXIT } from "../shared/exit-codes.js";
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
    expect(decideStop(null)).toEqual({ kind: "allow" });
  });

  it.each(["completed", "superseded", "failed", "paused", "suspended"] as const)(
    "non-running status '%s' → allow (intentional)",
    (status) => {
      expect(decideStop(run({ status }))).toEqual({ kind: "allow" });
    },
  );
});

describe("decideStop — workflow mode → allow (the Workflow drives, not the session)", () => {
  it("workflow-mode run with pending work → allow", () => {
    const action = decideStop(run({ mode: "workflow" }, { t1: task({ status: "executing" }) }));
    expect(action).toEqual({ kind: "allow" });
  });

  it("workflow-mode run with zero tasks (setup unfinished) → allow", () => {
    expect(decideStop(run({ mode: "workflow" }, {}))).toEqual({ kind: "allow" });
  });

  it("workflow-mode all-terminal run → allow (the Workflow finalizes, not the Stop hook)", () => {
    // In workflow mode the session must not finalize-on-stop either; the Workflow
    // returns all-terminal and the launching command runs `factory run finalize`.
    const action = decideStop(
      run({ mode: "workflow" }, { a: task({ task_id: "a", status: "done" }) }),
    );
    expect(action).toEqual({ kind: "allow" });
  });
});

describe("decideStop — session-ownership", () => {
  const OWNER = "session-owner-abc";

  it("owner known + stopping session != owner → allow, even all-terminal (never finalize another session's run)", () => {
    // Strengthened vs the old block-era test: an all-terminal run proves the non-owner
    // does not FINALIZE it (the only mutation left), not merely that it isn't blocked.
    const action = decideStop(
      run({ mode: "session", owner_session: OWNER }, { a: task({ task_id: "a", status: "done" }) }),
      "some-other-session",
    );
    expect(action).toEqual({ kind: "allow" });
  });

  it("owner known + stopping session == owner + all-terminal → finalize (the real owner)", () => {
    const action = decideStop(
      run({ mode: "session", owner_session: OWNER }, { a: task({ task_id: "a", status: "done" }) }),
      OWNER,
    );
    expect(action).toEqual({ kind: "finalize", status: "completed" });
  });

  it("owner known + stopping session == owner + pending work → allow (NO hostage; resumable)", () => {
    const action = decideStop(
      run({ mode: "session", owner_session: OWNER }, { t1: task({ status: "executing" }) }),
      OWNER,
    );
    expect(action).toEqual({ kind: "allow" });
  });

  it("owner known + stopping session UNKNOWN (no stdin) + all-terminal → finalize (degraded path still finalizes own run)", () => {
    const action = decideStop(
      run({ mode: "session", owner_session: OWNER }, { a: task({ task_id: "a", status: "done" }) }),
      undefined,
    );
    expect(action).toEqual({ kind: "finalize", status: "completed" });
  });
});

describe("decideStop — session-mode pending work → allow (the session-hostage fix)", () => {
  it("allows the stop when a task is in-flight (no block, run stays resumable)", () => {
    const action = decideStop(run({}, { t1: task({ task_id: "t1", status: "executing" }) }));
    expect(action).toEqual({ kind: "allow" });
  });

  it("allows the stop when setup is unfinished (zero tasks)", () => {
    expect(decideStop(run({}, {}))).toEqual({ kind: "allow" });
  });
});

describe("decideStop — session-mode, all tasks terminal → finalize", () => {
  it("every task done → finalize completed", () => {
    const action = decideStop(
      run(
        {},
        { a: task({ task_id: "a", status: "done" }), b: task({ task_id: "b", status: "done" }) },
      ),
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
    );
    expect(action).toEqual({ kind: "finalize", status: "failed" });
  });

  it("all dropped (zero done) → finalize failed", () => {
    const action = decideStop(
      run({}, { a: task({ task_id: "a", status: "dropped", failure_class: "spec-defect" }) }),
    );
    expect(action).toEqual({ kind: "finalize", status: "failed" });
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
    const code = await runStopGate([], { manager, emit, readRaw: emptyStdin });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]);
    expect(manager.finalize).not.toHaveBeenCalled();
  });

  it("pending work → allow (emits nothing, no finalize) — the session-hostage fix", async () => {
    const { out, emit } = emitter();
    const finalize = vi.fn();
    const manager = {
      findActiveByOwner: async () => null,
      readCurrent: async () => run({}, { t1: task({ status: "executing" }) }),
      finalize,
    };
    const code = await runStopGate([], { manager, emit, readRaw: emptyStdin });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("all-terminal run → finalizes to the derived status, OK, no block", async () => {
    const { out, emit } = emitter();
    const finalize = vi.fn(async () => run({ status: "completed" }));
    const manager = {
      findActiveByOwner: async () => null,
      readCurrent: async () => run({}, { a: task({ task_id: "a", status: "done" }) }),
      finalize,
    };
    const code = await runStopGate([], { manager, emit, readRaw: emptyStdin });
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
    const code = await runStopGate([], { manager, emit, readRaw: emptyStdin });
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
    const code = await runStopGate([], { manager, emit, readRaw: emptyStdin });
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
    const code = await runStopGate([], { manager, emit, readRaw: emptyStdin });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("reads the stopping session_id from stdin → unrelated session never finalizes the owner's run", async () => {
    // owner-1's run is ALL-TERMINAL: if the intruder WRONGLY adopted it, finalize would
    // fire. Asserting no-finalize proves owner-scoped resolution excludes the intruder.
    const { out, emit } = emitter();
    const finalize = vi.fn();
    const owner1 = run(
      { mode: "session", owner_session: "owner-1" },
      { a: task({ task_id: "a", status: "done" }) },
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
    const code = await runStopGate([], { manager, emit, readRaw });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]); // allow: a different session must not touch this run
    expect(finalize).not.toHaveBeenCalled();
  });

  it("stdin session_id == owner + all-terminal → finalizes the owning session's run", async () => {
    const { out, emit } = emitter();
    const owner1 = run(
      { mode: "session", owner_session: "owner-1" },
      { a: task({ task_id: "a", status: "done" }) },
    );
    const finalize = vi.fn(async () => run({ status: "completed" }));
    const manager = {
      findActiveByOwner: async (s: string) => (s === "owner-1" ? owner1 : null),
      readCurrent: async () => owner1,
      finalize,
    };
    const readRaw = async () => JSON.stringify({ session_id: "owner-1", hook_event_name: "Stop" });
    const code = await runStopGate([], { manager, emit, readRaw });
    expect(code).toBe(EXIT.OK);
    expect(finalize).toHaveBeenCalledWith("run-x", "completed");
    expect(out).toEqual([]);
  });

  it("stdin session_id == owner + pending → allow (no block, no finalize)", async () => {
    const { out, emit } = emitter();
    const finalize = vi.fn();
    const owner1 = run(
      { mode: "session", owner_session: "owner-1" },
      { t1: task({ status: "executing" }) },
    );
    const manager = {
      findActiveByOwner: async (s: string) => (s === "owner-1" ? owner1 : null),
      readCurrent: async () => owner1,
      finalize,
    };
    const readRaw = async () => JSON.stringify({ session_id: "owner-1", hook_event_name: "Stop" });
    const code = await runStopGate([], { manager, emit, readRaw });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]);
    expect(finalize).not.toHaveBeenCalled();
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
    const code = await runStopGate([], { manager, emit, readRaw });
    expect(code).toBe(EXIT.OK);
    expect(finalize).toHaveBeenCalledWith("run-A", "completed"); // NOT run-B
    expect(out).toEqual([]);
  });

  it("known stopper owning no run + UN-stamped all-terminal current → adopts it → finalize", async () => {
    // A known stopper that owns no stamped run still adopts an un-owned `runs/current`
    // (legacy/un-stamped). Making it all-terminal proves adoption via the finalize call.
    const { out, emit } = emitter();
    const unstamped = run({ mode: "session" }, { a: task({ task_id: "a", status: "done" }) });
    const finalize = vi.fn(async () => run({ status: "completed" }));
    const manager = {
      findActiveByOwner: async (_s: string) => null,
      readCurrent: async () => unstamped,
      finalize,
    };
    const readRaw = async () => JSON.stringify({ session_id: "sess-A", hook_event_name: "Stop" });
    const code = await runStopGate([], { manager, emit, readRaw });
    expect(code).toBe(EXIT.OK);
    expect(finalize).toHaveBeenCalledWith("run-x", "completed");
    expect(out).toEqual([]);
  });

  it("known stopper owning no run + all-terminal current owned by a DIFFERENT session → never finalize it", async () => {
    // current is all-terminal AND owned by sess-B: if it were wrongly adopted, finalize
    // would fire. Asserting no-finalize proves we never touch another session's run.
    const { out, emit } = emitter();
    const otherOwner = run(
      { mode: "session", owner_session: "sess-B" },
      { a: task({ task_id: "a", status: "done" }) },
    );
    const finalize = vi.fn();
    const manager = {
      findActiveByOwner: async (_s: string) => null,
      readCurrent: async () => otherOwner, // a DIFFERENT known owner's run
      finalize,
    };
    const readRaw = async () => JSON.stringify({ session_id: "sess-A", hook_event_name: "Stop" });
    const code = await runStopGate([], { manager, emit, readRaw });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]); // not ours → never finalize another session's run
    expect(finalize).not.toHaveBeenCalled();
  });

  it("malformed stdin → unknown stopper degrades to runs/current and still finalizes an all-terminal run", async () => {
    // A corrupt stdin loses session-scoping; resolution falls back to runs/current.
    // An all-terminal current still finalizes — proving the degrade is graceful, not fatal.
    const { out, emit } = emitter();
    const finalize = vi.fn(async () => run({ status: "completed" }));
    const manager = {
      findActiveByOwner: async () => null,
      readCurrent: async () =>
        run(
          { mode: "session", owner_session: "owner-1" },
          { a: task({ task_id: "a", status: "done" }) },
        ),
      finalize,
    };
    const readRaw = async () => "}{ not json";
    const code = await runStopGate([], { manager, emit, readRaw });
    expect(code).toBe(EXIT.OK);
    expect(finalize).toHaveBeenCalledWith("run-x", "completed");
    expect(out).toEqual([]);
  });
});
