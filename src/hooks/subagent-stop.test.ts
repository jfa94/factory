/**
 * WS9 — SubagentStop transcript→state seam tests. A reviewer's STATUS verdict is
 * appended to the task's reviewers[] through StateManager.updateTask (atomic,
 * never raw fs). Non-reviewer roles write nothing; an unresolved task_id is
 * logged and SKIPPED (no silent state loss); a state write failure → ERROR.
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
import { EXIT } from "../cli/exit-codes.js";
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
 * A fake StateManager: readCurrent returns the supplied run; updateTask applies
 * the mutator to the named task and records the call so the test can assert.
 */
function fakeManager(initial: RunState) {
  const calls: Array<{ runId: string; taskId: string; next: TaskState }> = [];
  let state = initial;
  return {
    calls,
    manager: {
      readCurrent: async () => state,
      updateTask: async (runId: string, taskId: string, mutator: (t: TaskState) => TaskState) => {
        const next = mutator(state.tasks[taskId]!);
        calls.push({ runId, taskId, next });
        state = { ...state, tasks: { ...state.tasks, [taskId]: next } };
        return state;
      },
    },
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

describe("handleSubagentStop — append ReviewerResult via StateManager", () => {
  it("appends an approve result for a reviewer (explicit task_id)", async () => {
    const { manager, calls } = fakeManager(run({ t1: task() }));
    await handleSubagentStop(
      input({
        agent_type: "quality-reviewer",
        last_assistant_message: "STATUS: DONE",
      }),
      { manager, explicitTaskId: "t1" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.next.reviewers).toEqual([
      { reviewer: "quality", verdict: "approve", confirmed_blockers: 0 },
    ]);
  });

  it("records a blocked result with ≥1 confirmed blocker (schema coherence)", async () => {
    const { manager, calls } = fakeManager(run({ t1: task() }));
    await handleSubagentStop(
      input({ agent_type: "security-reviewer", last_assistant_message: "STATUS: BLOCKED" }),
      { manager, explicitTaskId: "t1" },
    );
    expect(calls[0]!.next.reviewers).toEqual([
      { reviewer: "security", verdict: "blocked", confirmed_blockers: 1 },
    ]);
  });

  it("resolves task_id from the transcript [task:] header", async () => {
    const { manager, calls } = fakeManager(run({ t1: task({ task_id: "t1" }) }));
    const readTranscript = vi.fn(async () => "[task:t1] reviewer transcript\nSTATUS: DONE");
    await handleSubagentStop(
      input({
        agent_type: "implementation-reviewer",
        agent_transcript_path: "/tmp/transcript.jsonl",
        last_assistant_message: "STATUS: DONE",
      }),
      { manager, readTranscript },
    );
    expect(readTranscript).toHaveBeenCalledWith("/tmp/transcript.jsonl");
    expect(calls[0]!.taskId).toBe("t1");
    expect(calls[0]!.next.reviewers[0]!.reviewer).toBe("implementation");
  });

  it("falls back to the single reviewing task when no id is given", async () => {
    const { manager, calls } = fakeManager(
      run({
        t1: task({ task_id: "t1", status: "reviewing" }),
        t2: task({ task_id: "t2", status: "done" }),
      }),
    );
    await handleSubagentStop(
      input({ agent_type: "quality-reviewer", last_assistant_message: "STATUS: DONE" }),
      { manager },
    );
    expect(calls[0]!.taskId).toBe("t1");
  });

  it("last-writer-wins per reviewer (re-run replaces the prior result)", async () => {
    const { manager, calls } = fakeManager(
      run({
        t1: task({
          reviewers: [{ reviewer: "quality", verdict: "blocked", confirmed_blockers: 2 }],
        }),
      }),
    );
    await handleSubagentStop(
      input({ agent_type: "quality-reviewer", last_assistant_message: "STATUS: DONE" }),
      { manager, explicitTaskId: "t1" },
    );
    expect(calls[0]!.next.reviewers).toEqual([
      { reviewer: "quality", verdict: "approve", confirmed_blockers: 0 },
    ]);
  });

  it("non-reviewer role → no write", async () => {
    const { manager, calls } = fakeManager(run({ t1: task() }));
    const res = await handleSubagentStop(
      input({ agent_type: "task-executor", last_assistant_message: "STATUS: DONE" }),
      { manager, explicitTaskId: "t1" },
    );
    expect(res).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("unresolved task_id (ambiguous, no header) → skip write, no state loss", async () => {
    const { manager, calls } = fakeManager(
      run({ t1: task({ task_id: "t1" }), t2: task({ task_id: "t2" }) }),
    );
    const res = await handleSubagentStop(
      input({ agent_type: "quality-reviewer", last_assistant_message: "STATUS: DONE" }),
      { manager },
    );
    expect(res).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("resolved task_id absent from run → skip write", async () => {
    const { manager, calls } = fakeManager(run({ t1: task() }));
    const res = await handleSubagentStop(
      input({ agent_type: "quality-reviewer", last_assistant_message: "STATUS: DONE" }),
      { manager, explicitTaskId: "ghost" },
    );
    expect(res).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("no active run → skip write", async () => {
    const manager = { readCurrent: async () => null, updateTask: vi.fn() };
    const res = await handleSubagentStop(
      input({ agent_type: "quality-reviewer", last_assistant_message: "STATUS: DONE" }),
      { manager, explicitTaskId: "t1" },
    );
    expect(res).toBeNull();
    expect(manager.updateTask).not.toHaveBeenCalled();
  });
});

describe("runSubagentStop — exit codes (observational)", () => {
  it("malformed input → OK (must not block the subagent stop)", async () => {
    const code = await runSubagentStop([], { readRaw: async () => "{bad" });
    expect(code).toBe(EXIT.OK);
  });

  it("a successful append → OK", async () => {
    const { manager } = fakeManager(run({ t1: task() }));
    const code = await runSubagentStop([], {
      manager,
      explicitTaskId: "t1",
      readRaw: async () =>
        JSON.stringify({ agent_type: "quality-reviewer", last_assistant_message: "STATUS: DONE" }),
    });
    expect(code).toBe(EXIT.OK);
  });

  it("a skipped write (non-reviewer) → OK", async () => {
    const { manager } = fakeManager(run({ t1: task() }));
    const code = await runSubagentStop([], {
      manager,
      readRaw: async () =>
        JSON.stringify({ agent_type: "task-executor", last_assistant_message: "STATUS: DONE" }),
    });
    expect(code).toBe(EXIT.OK);
  });

  it("a state write failure → ERROR (orchestrator must notice lost state)", async () => {
    const manager = {
      readCurrent: async () => run({ t1: task() }),
      updateTask: async () => {
        throw new Error("disk full");
      },
    };
    const code = await runSubagentStop([], {
      manager,
      explicitTaskId: "t1",
      readRaw: async () =>
        JSON.stringify({ agent_type: "quality-reviewer", last_assistant_message: "STATUS: DONE" }),
    });
    expect(code).toBe(EXIT.ERROR);
  });
});
