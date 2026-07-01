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
    schema_version: 2,
    run_id: "run-x",
    status: "running",
    execution_mode: "balanced",
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

describe("decideStop — debug mode → allow (the debug driver owns finalize between passes)", () => {
  it("session-owned, running, all-terminal, debug:true → allow (NOT finalize)", () => {
    // Exact scenario that would previously have incorrectly finalized: absent the
    // debug guard, this is the "every task done → finalize completed" case below.
    const action = decideStop(run({ debug: true }, { a: task({ task_id: "a", status: "done" }) }));
    expect(action).toEqual({ kind: "allow" });
  });

  it("debug:true with pending work → allow (already allowed, but stays allow)", () => {
    const action = decideStop(run({ debug: true }, { t1: task({ status: "executing" }) }));
    expect(action).toEqual({ kind: "allow" });
  });

  it("debug:false (explicit), all-terminal → finalize as before (regression guard)", () => {
    const action = decideStop(run({ debug: false }, { a: task({ task_id: "a", status: "done" }) }));
    expect(action).toEqual({ kind: "finalize", status: "completed" });
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

  it("mix of done + failed → finalize failed (Decision 34: no partial rollup)", () => {
    const action = decideStop(
      run(
        {},
        {
          a: task({ task_id: "a", status: "done" }),
          b: task({ task_id: "b", status: "failed", failure_class: "capability-budget" }),
        },
      ),
    );
    expect(action).toEqual({ kind: "finalize", status: "failed" });
  });

  it("all failed (zero done) → finalize failed", () => {
    const action = decideStop(
      run({}, { a: task({ task_id: "a", status: "failed", failure_class: "spec-defect" }) }),
    );
    expect(action).toEqual({ kind: "finalize", status: "failed" });
  });
});

describe("runStopGate — I/O wiring", () => {
  function emitter() {
    const out: string[] = [];
    return { out, emit: (s: string) => out.push(s) };
  }

  // Helper: produce a Stop-hook stdin payload for the given session.
  const stdin = (sessionId: string) => async () =>
    JSON.stringify({ session_id: sessionId, hook_event_name: "Stop" });

  it("no active run → OK, emits nothing", async () => {
    const { out, emit } = emitter();
    const manager = { findActiveByOwner: async () => null, finalize: vi.fn() };
    const code = await runStopGate([], { manager, emit, readRaw: stdin("sess-a") });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]);
    expect(manager.finalize).not.toHaveBeenCalled();
  });

  it("pending work → allow (emits nothing, no finalize)", async () => {
    const { out, emit } = emitter();
    const finalize = vi.fn();
    const manager = {
      findActiveByOwner: async (s: string) =>
        s === "sess-a" ? run({}, { t1: task({ status: "executing" }) }) : null,
      finalize,
    };
    const code = await runStopGate([], { manager, emit, readRaw: stdin("sess-a") });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("all-terminal run → finalizes to the derived status, OK, no block", async () => {
    const { out, emit } = emitter();
    const finalize = vi.fn(async () => run({ status: "completed" }));
    const manager = {
      findActiveByOwner: async (s: string) =>
        s === "sess-a" ? run({}, { a: task({ task_id: "a", status: "done" }) }) : null,
      finalize,
    };
    const code = await runStopGate([], { manager, emit, readRaw: stdin("sess-a") });
    expect(code).toBe(EXIT.OK);
    expect(finalize).toHaveBeenCalledWith("run-x", "completed");
    expect(out).toEqual([]);
  });

  it("finalize failure → blocks (surface inconsistency), OK", async () => {
    const { out, emit } = emitter();
    const manager = {
      findActiveByOwner: async (s: string) =>
        s === "sess-a" ? run({}, { a: task({ task_id: "a", status: "done" }) }) : null,
      finalize: vi.fn(async () => {
        throw new Error("disk full");
      }),
    };
    const code = await runStopGate([], { manager, emit, readRaw: stdin("sess-a") });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out[0]!)).toMatchObject({ decision: "block" });
    expect(out[0]!).toContain("finalize-on-stop failed");
  });

  it("foreign corrupt run → allow (stop-gate never reads another session's run state)", async () => {
    // The cross-contamination scenario: a live run belonging to another session is
    // unreadable (schema mismatch, mid-write). listRuns() skips it with a log.warn,
    // findActiveByOwner returns null, and the gate allows — runs/current never touched.
    const { out, emit } = emitter();
    const code = await runStopGate([], {
      manager: { findActiveByOwner: async () => null, finalize: vi.fn() },
      emit,
      readRaw: stdin("sess-a"),
    });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]); // allow — not our run
  });

  it("data-dir unreadable (non-ENOENT readdir failure) → block (local filesystem error)", async () => {
    // findActiveByOwner → listRuns → readdir fails: our OWN data directory is broken.
    // Foreign runs' unreadable state.json never causes a block (listRuns skips them).
    const { out, emit } = emitter();
    const code = await runStopGate([], {
      manager: {
        findActiveByOwner: async () => {
          throw new Error("EACCES: permission denied");
        },
        finalize: vi.fn(),
      },
      emit,
      readRaw: stdin("sess-a"),
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out[0]!)).toMatchObject({ decision: "block" });
    expect(out[0]!).toContain("run state");
    expect(out[0]!).not.toContain("runs/current"); // must not blame a foreign pointer
  });

  it("workflow-mode run → allow, emits nothing, no finalize (session is not the orchestrator)", async () => {
    const { out, emit } = emitter();
    const finalize = vi.fn();
    const manager = {
      findActiveByOwner: async (s: string) =>
        s === "sess-a" ? run({ mode: "workflow" }, { t1: task({ status: "executing" }) }) : null,
      finalize,
    };
    const code = await runStopGate([], { manager, emit, readRaw: stdin("sess-a") });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("reads the stopping session_id from stdin → unrelated session never finalizes the owner's run", async () => {
    // owner-1's run is ALL-TERMINAL: if the intruder WRONGLY resolved it, finalize would
    // fire. Asserting no-finalize proves owner-scoped resolution excludes the intruder.
    const { out, emit } = emitter();
    const finalize = vi.fn();
    const owner1 = run(
      { mode: "session", owner_session: "owner-1" },
      { a: task({ task_id: "a", status: "done" }) },
    );
    const manager = {
      // intruder-9 owns nothing; owner-1's run is stamped and not returned → pass through.
      findActiveByOwner: async (s: string) => (s === "owner-1" ? owner1 : null),
      finalize,
    };
    const code = await runStopGate([], {
      manager,
      emit,
      readRaw: stdin("intruder-9"),
    });
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
      finalize,
    };
    const code = await runStopGate([], {
      manager,
      emit,
      readRaw: stdin("owner-1"),
    });
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
      finalize,
    };
    const code = await runStopGate([], {
      manager,
      emit,
      readRaw: stdin("owner-1"),
    });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("CLOBBER FIX: finalizes the run the STOPPING session owns, not runs/current", async () => {
    // The bug: runs/current was repointed to another session's run-B; the owner of
    // run-A (all tasks done) reads `current` → run-B (owner-B, still live) → ALLOW
    // → run-A dangles `running`. Owner-scoped resolution finalizes run-A correctly.
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
      finalize,
    };
    const code = await runStopGate([], {
      manager,
      emit,
      readRaw: stdin("sess-A"),
    });
    expect(code).toBe(EXIT.OK);
    expect(finalize).toHaveBeenCalledWith("run-A", "completed"); // NOT run-B
    expect(out).toEqual([]);
  });

  it("known stopper owning no run → allow (no global-pointer adoption)", async () => {
    // A known stopper with no active run passes through — runs/current is never consulted.
    const { out, emit } = emitter();
    const finalize = vi.fn();
    const code = await runStopGate([], {
      manager: { findActiveByOwner: async () => null, finalize },
      emit,
      readRaw: stdin("sess-a"),
    });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("unknown stopper (malformed stdin) → allow, no finalize", async () => {
    // An unscoped stop (no session id parseable from stdin) resolves null and allows —
    // it no longer falls back to runs/current. The run stays resumable.
    const { out, emit } = emitter();
    const finalize = vi.fn();
    const code = await runStopGate([], {
      manager: { findActiveByOwner: async () => null, finalize },
      emit,
      readRaw: async () => "}{ not json",
    });
    expect(code).toBe(EXIT.OK);
    expect(out).toEqual([]);
    expect(finalize).not.toHaveBeenCalled();
  });
});
