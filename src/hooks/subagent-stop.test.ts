/**
 * WS9 — SubagentStop transcript→state seam tests.
 *
 * The hook is now LOG-ONLY (observational). It parses reviewer verdicts, resolves
 * the task_id, and logs loudly — but never writes to task.reviewers[] (the driver
 * fold is the single writer). Tests assert:
 *   - reviewerNameOf / parseVerdict / taskIdFromHeader pure helpers behave correctly
 *   - handleSubagentStop resolves reviewer+task and returns null (no state write)
 *   - The injected manager's updateTask is NEVER called for any input
 *   - Non-reviewer roles are skipped immediately (no manager call)
 *   - All exit paths return OK (fully observational — never blocks a subagent stop)
 *
 * The StateManager + transcript reader are injected — no real run store needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleSubagentStop,
  runSubagentStop,
  reviewerNameOf,
  parseVerdict,
  taskIdFromHeader,
} from "./subagent-stop.js";
import { parseHookInput } from "./hook-io.js";
import { EXIT } from "../shared/exit-codes.js";
import type { RunState, TaskState } from "../types/index.js";

const SPEC = { repo: "o/n", spec_id: "1-x", issue_number: 1 } as const;

function task(over: Partial<TaskState> = {}): TaskState {
  return {
    task_id: "t1",
    status: "reviewing",
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

/**
 * A fake manager: findActiveByOwner returns the supplied run regardless of session;
 * updateTask is a spy so tests can assert it is NEVER called (the hook is observational).
 */
function fakeManager(initial: RunState) {
  return {
    findActiveByOwner: async (_s: string) => initial,
    updateTask: vi.fn(async () => initial),
  };
}

function input(fields: Record<string, unknown>) {
  return parseHookInput(JSON.stringify(fields));
}

const origTaskId = process.env.FACTORY_TASK_ID;
beforeEach(() => {
  delete process.env.FACTORY_TASK_ID;
});
afterEach(() => {
  if (origTaskId === undefined) delete process.env.FACTORY_TASK_ID;
  else process.env.FACTORY_TASK_ID = origTaskId;
});

describe("reviewerNameOf", () => {
  it("maps each reviewer role to its identity (and strips factory: prefix)", () => {
    expect(reviewerNameOf("implementation-reviewer")).toBe("implementation");
    expect(reviewerNameOf("factory:quality-reviewer")).toBe("quality");
    expect(reviewerNameOf("architecture-reviewer")).toBe("architecture");
    expect(reviewerNameOf("security-reviewer")).toBe("security");
    expect(reviewerNameOf("silent-failure-hunter")).toBe("silent-failure");
    expect(reviewerNameOf("type-design-reviewer")).toBe("type-design");
  });

  it("returns null for non-reviewer roles", () => {
    expect(reviewerNameOf("task-executor")).toBeNull();
    expect(reviewerNameOf("test-writer")).toBeNull();
    expect(reviewerNameOf("")).toBeNull();
  });
});

describe("parseVerdict", () => {
  it("STATUS: DONE → approve", () => {
    expect(parseVerdict("...\nSTATUS: DONE")).toBe("approve");
  });
  it("STATUS: BLOCKED → blocked", () => {
    expect(parseVerdict("STATUS: BLOCKED")).toBe("blocked");
  });
  it("any non-DONE status → blocked (fail-loud, never silently approve)", () => {
    expect(parseVerdict("STATUS: NEEDS_CONTEXT")).toBe("blocked");
  });
  it("absent status → blocked", () => {
    expect(parseVerdict(undefined)).toBe("blocked");
    expect(parseVerdict("no status here")).toBe("blocked");
  });
  it("takes the LAST status line when several appear", () => {
    expect(parseVerdict("STATUS: BLOCKED\n...\nSTATUS: DONE")).toBe("approve");
  });
});

describe("taskIdFromHeader", () => {
  it("extracts [task:<id>] from transcript text", () => {
    expect(taskIdFromHeader("preamble [task:auth-7] body")).toBe("auth-7");
  });
  it("returns null without a header", () => {
    expect(taskIdFromHeader("no header")).toBeNull();
    expect(taskIdFromHeader(undefined)).toBeNull();
  });
});

describe("handleSubagentStop — observational (NO state write)", () => {
  // All inputs include session_id so handleSubagentStop can resolve the run via
  // findActiveByOwner. fakeManager returns the run for any session.
  it("reviewer input resolves verdict + returns null — updateTask NOT called", async () => {
    const manager = fakeManager(run({ t1: task() }));
    const result = await handleSubagentStop(
      input({
        session_id: "test-session",
        agent_type: "quality-reviewer",
        last_assistant_message: "STATUS: DONE",
      }),
      { manager, explicitTaskId: "t1" },
    );
    expect(result).toBeNull();
    expect(manager.updateTask).not.toHaveBeenCalled();
  });

  it("blocked reviewer input → null, no state write", async () => {
    const manager = fakeManager(run({ t1: task() }));
    const result = await handleSubagentStop(
      input({
        session_id: "test-session",
        agent_type: "security-reviewer",
        last_assistant_message: "STATUS: BLOCKED",
      }),
      { manager, explicitTaskId: "t1" },
    );
    expect(result).toBeNull();
    expect(manager.updateTask).not.toHaveBeenCalled();
  });

  it("resolves task_id from the transcript [task:] header — no write", async () => {
    const manager = fakeManager(run({ t1: task({ task_id: "t1" }) }));
    const readTranscript = vi.fn(async () => "[task:t1] reviewer transcript\nSTATUS: DONE");
    const result = await handleSubagentStop(
      input({
        session_id: "test-session",
        agent_type: "implementation-reviewer",
        agent_transcript_path: "/tmp/transcript.jsonl",
        last_assistant_message: "STATUS: DONE",
      }),
      { manager, readTranscript },
    );
    expect(readTranscript).toHaveBeenCalledWith("/tmp/transcript.jsonl");
    expect(result).toBeNull();
    expect(manager.updateTask).not.toHaveBeenCalled();
  });

  it("falls back to the single reviewing task — no write", async () => {
    const manager = fakeManager(
      run({
        t1: task({ task_id: "t1", status: "reviewing" }),
        t2: task({ task_id: "t2", status: "done" }),
      }),
    );
    const result = await handleSubagentStop(
      input({
        session_id: "test-session",
        agent_type: "quality-reviewer",
        last_assistant_message: "STATUS: DONE",
      }),
      { manager },
    );
    expect(result).toBeNull();
    expect(manager.updateTask).not.toHaveBeenCalled();
  });

  it("non-reviewer role → null, no manager call at all", async () => {
    const manager = fakeManager(run({ t1: task() }));
    const result = await handleSubagentStop(
      input({ agent_type: "task-executor", last_assistant_message: "STATUS: DONE" }),
      { manager, explicitTaskId: "t1" },
    );
    expect(result).toBeNull();
    expect(manager.updateTask).not.toHaveBeenCalled();
  });

  it("unresolved task_id (ambiguous, no header) → null, no write", async () => {
    const manager = fakeManager(run({ t1: task({ task_id: "t1" }), t2: task({ task_id: "t2" }) }));
    const result = await handleSubagentStop(
      input({
        session_id: "test-session",
        agent_type: "quality-reviewer",
        last_assistant_message: "STATUS: DONE",
      }),
      { manager },
    );
    expect(result).toBeNull();
    expect(manager.updateTask).not.toHaveBeenCalled();
  });

  it("resolved task_id absent from run → null, no write", async () => {
    const manager = fakeManager(run({ t1: task() }));
    const result = await handleSubagentStop(
      input({
        session_id: "test-session",
        agent_type: "quality-reviewer",
        last_assistant_message: "STATUS: DONE",
      }),
      { manager, explicitTaskId: "ghost" },
    );
    expect(result).toBeNull();
    expect(manager.updateTask).not.toHaveBeenCalled();
  });

  it("no active run → null, no write", async () => {
    const manager = { findActiveByOwner: async () => null, updateTask: vi.fn() };
    const result = await handleSubagentStop(
      input({
        session_id: "test-session",
        agent_type: "quality-reviewer",
        last_assistant_message: "STATUS: DONE",
      }),
      { manager, explicitTaskId: "t1" },
    );
    expect(result).toBeNull();
    expect(manager.updateTask).not.toHaveBeenCalled();
  });

  it("no session_id in input → null, no write (unattributable subagent stop)", async () => {
    // Without a session_id the hook cannot resolve a run and skips logging.
    const manager = fakeManager(run({ t1: task() }));
    const result = await handleSubagentStop(
      input({ agent_type: "quality-reviewer", last_assistant_message: "STATUS: DONE" }),
      { manager, explicitTaskId: "t1" },
    );
    expect(result).toBeNull();
    expect(manager.updateTask).not.toHaveBeenCalled();
  });
});

describe("runSubagentStop — exit codes (fully observational)", () => {
  it("malformed input → OK (must not block the subagent stop)", async () => {
    const code = await runSubagentStop([], { readRaw: async () => "{bad" });
    expect(code).toBe(EXIT.OK);
  });

  it("reviewer input → OK (log-only, no state write to fail)", async () => {
    const manager = fakeManager(run({ t1: task() }));
    const code = await runSubagentStop([], {
      manager,
      explicitTaskId: "t1",
      readRaw: async () =>
        JSON.stringify({
          session_id: "test-session",
          agent_type: "quality-reviewer",
          last_assistant_message: "STATUS: DONE",
        }),
    });
    expect(code).toBe(EXIT.OK);
  });

  it("non-reviewer role → OK", async () => {
    const manager = fakeManager(run({ t1: task() }));
    const code = await runSubagentStop([], {
      manager,
      readRaw: async () =>
        JSON.stringify({ agent_type: "task-executor", last_assistant_message: "STATUS: DONE" }),
    });
    expect(code).toBe(EXIT.OK);
  });

  it("run-state read failure → OK (observational; log is the signal, never blocks stop)", async () => {
    // findActiveByOwner throws (e.g. the data dir is inaccessible): runSubagentStop
    // catches and swallows the error so the subagent is never blocked.
    const manager = {
      findActiveByOwner: async () => {
        throw new Error("disk full");
      },
      updateTask: vi.fn(),
    };
    const code = await runSubagentStop([], {
      manager,
      explicitTaskId: "t1",
      readRaw: async () =>
        JSON.stringify({
          session_id: "test-session",
          agent_type: "quality-reviewer",
          last_assistant_message: "STATUS: DONE",
        }),
    });
    expect(code).toBe(EXIT.OK);
    expect(manager.updateTask).not.toHaveBeenCalled();
  });
});
