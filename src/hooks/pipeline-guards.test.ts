/**
 * WS9 — pipeline-invariant guard tests.
 *
 * The load-bearing property: while a run is active, ship commands
 * (`gh pr create`/`gh pr merge`) are categorically denied — the factory ENGINE
 * opens and merges PRs from inside `factory next-action` (a child_process gh call that
 * never transits this Bash-tool hook), so any ship command reaching the hook is an
 * agent-initiated attempt. Also covers: no active run → pass through; test-writer
 * phase write-scope; nested-shell denial while a run is active; dangling-symlink
 * fail closed via runPipelineGuards.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { decidePipelineGuards, runPipelineGuards } from "./pipeline-guards.js";
import { BrokenRunStateError, type ActiveRun } from "./hook-context.js";
import { parseHookInput, isDeny } from "./hook-io.js";
import { EXIT } from "../shared/exit-codes.js";
import type { RunState, TaskState } from "../types/index.js";

const SPEC = { repo: "o/n", spec_id: "1-x", issue_number: 1 } as const;

function task(over: Partial<TaskState> = {}): TaskState {
  return {
    task_id: "t1",
    status: "shipping",
    depends_on: [],
    risk_tier: "low",
    escalation_rung: 0,
    reviewers: [],
    ...over,
  } as TaskState;
}

function runState(tasks: Record<string, TaskState>): RunState {
  return {
    schema_version: 1,
    run_id: "run-x",
    status: "running",
    execution_mode: "balanced",
    spec: SPEC,
    tasks,
    started_at: "t",
    updated_at: "t",
    ended_at: null,
  } as RunState;
}

function activeRun(tasks: Record<string, TaskState>): ActiveRun {
  return { dataDir: "/data", run: runState(tasks) };
}

/** A loadRun seam (Bash arms) that returns a fixed run (or null). */
function withRun(run: ActiveRun | null) {
  return async () => run;
}

/** A per-run-id loader seam (write-scope arm): returns a run, or throws an injected error. */
function withRunById(run: RunState | Error) {
  return async () => {
    if (run instanceof Error) throw run;
    return run;
  };
}

function bash(command: string) {
  return parseHookInput(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
}
function write(file_path: string) {
  return parseHookInput(JSON.stringify({ tool_name: "Write", tool_input: { file_path } }));
}
/** A Write whose target is inside a task's worktree (`<dataDir>/worktrees/<run>/<task>/…`). */
function writeInWorktree(runId: string, taskId: string, rel: string) {
  return write(join("/data", "worktrees", runId, taskId, rel));
}

const APPROVE = { reviewer: "quality", verdict: "approve", confirmed_blockers: 0 } as const;

describe("pipeline-guards — no active run passes through", () => {
  it("allows any write when there is no active run", async () => {
    const d = await decidePipelineGuards(write("/repo/src/x.ts"), { loadRun: withRun(null) });
    expect(isDeny(d)).toBe(false);
  });
});

describe("pipeline-guards — ship guard is agent-deny while a run is active", () => {
  // The engine ships from inside `factory next-action` (a child_process gh call that
  // never transits this Bash-tool hook — src/driver/ship.ts), so ANY ship command
  // reaching the hook is an agent-initiated attempt and is categorically denied,
  // independent of reviewers / pr_number / gate evidence.
  it("denies gh pr create while a run is active", async () => {
    const run = activeRun({ t1: task() });
    const d = await decidePipelineGuards(bash("gh pr create --fill"), { loadRun: withRun(run) });
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("ship_agent_denied");
  });

  it("denies gh pr merge while a run is active", async () => {
    const run = activeRun({ t1: task({ pr_number: 42 }) });
    const d = await decidePipelineGuards(bash("gh pr merge 42 --squash"), {
      loadRun: withRun(run),
    });
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) expect(d.reason).toBe("ship_agent_denied");
  });

  it("denies even when the task looks fully shippable (pure agent boundary, not merge-gate-derived)", async () => {
    // Unanimous approvals + a recorded pr_number — STILL denied: the hook no longer
    // derives a merge gate, agents simply never ship.
    const run = activeRun({ t1: task({ reviewers: [APPROVE], pr_number: 42 }) });
    const d = await decidePipelineGuards(bash("gh pr create --fill"), { loadRun: withRun(run) });
    expect(isDeny(d)).toBe(true);
  });

  // Regression: a prefixed/compound command must NOT evade the ship guard by
  // command composition (boundary-aware detection, not a leading-anchor match).
  it.each([
    "cd /repo && gh pr create --fill",
    "true; gh pr create --fill",
    "GH=1 gh pr create --fill",
    "echo hi | gh pr create --fill",
    "cd /repo && gh pr merge 42 --squash",
  ])("denies the compound ship command '%s'", async (cmd) => {
    const run = activeRun({ t1: task() });
    const d = await decidePipelineGuards(bash(cmd), { loadRun: withRun(run) });
    expect(isDeny(d)).toBe(true);
  });

  it("allows an unrelated gh command while a run is active (no over-block)", async () => {
    const run = activeRun({ t1: task() });
    const d = await decidePipelineGuards(bash("gh pr view 42"), { loadRun: withRun(run) });
    expect(isDeny(d)).toBe(false);
  });
});

describe("pipeline-guards — test-writer phase write-scope (path-anchored, TDD)", () => {
  // The write-scope arm derives its owning run+task from the TARGET PATH (the
  // worktree the producer writes into), NOT a global pointer — so it fires only on
  // a write into THAT run's worktree, never on an unrelated session's edit.
  const DATA = { dataDir: "/data" };

  it("blocks an implementation write into the task worktree during the test-writer phase", async () => {
    const run = runState({ t1: task({ status: "executing", producer_role: "test-writer" }) });
    const d = await decidePipelineGuards(writeInWorktree("run-x", "t1", "src/feature.ts"), {
      ...DATA,
      loadRunById: withRunById(run),
    });
    expect(isDeny(d)).toBe(true);
  });

  it("allows a test write into the worktree during the test-writer phase", async () => {
    const run = runState({ t1: task({ status: "executing", producer_role: "test-writer" }) });
    const d = await decidePipelineGuards(writeInWorktree("run-x", "t1", "src/feature.test.ts"), {
      ...DATA,
      loadRunById: withRunById(run),
    });
    expect(isDeny(d)).toBe(false);
  });

  it("allows an implementation write during the implementer (GREEN) phase", async () => {
    const run = runState({ t1: task({ status: "executing", producer_role: "implementer" }) });
    const d = await decidePipelineGuards(writeInWorktree("run-x", "t1", "src/feature.ts"), {
      ...DATA,
      loadRunById: withRunById(run),
    });
    expect(isDeny(d)).toBe(false);
  });

  it("allows an unrelated session's write to a NON-worktree checkout (spurious-block fix)", async () => {
    // No worktree match → the arm never even consults a run, even though a live
    // test-writer run exists. This is the cross-session false-positive the epic fixes.
    let consulted = false;
    const d = await decidePipelineGuards(write("/Users/dev/other-repo/src/x.ts"), {
      ...DATA,
      loadRunById: async () => {
        consulted = true;
        return runState({ t1: task({ status: "executing", producer_role: "test-writer" }) });
      },
    });
    expect(isDeny(d)).toBe(false);
    expect(consulted).toBe(false);
  });

  it("fails closed when the worktree path matches but the run state is missing/corrupt", async () => {
    const d = await decidePipelineGuards(writeInWorktree("run-x", "t1", "src/feature.ts"), {
      ...DATA,
      loadRunById: withRunById(new Error("ENOENT: state.json")),
    });
    expect(isDeny(d)).toBe(true);
  });

  it("does not block a worktree write once the task is past the test-writer phase", async () => {
    const run = runState({ t1: task({ status: "reviewing" }) });
    const d = await decidePipelineGuards(writeInWorktree("run-x", "t1", "src/feature.ts"), {
      ...DATA,
      loadRunById: withRunById(run),
    });
    expect(isDeny(d)).toBe(false);
  });
});

describe("pipeline-guards — nested shell denied while run active", () => {
  it("denies a nested shell when a run is active", async () => {
    const run = activeRun({ t1: task({ status: "executing" }) });
    const d = await decidePipelineGuards(bash("bash -c 'gh pr create'"), { loadRun: withRun(run) });
    expect(isDeny(d)).toBe(true);
  });
});

describe("pipeline-guards — runPipelineGuards fail-closed", () => {
  it("a BrokenRunStateError from the loader → ERROR (deny)", async () => {
    const code = await runPipelineGuards([], {
      readRaw: async () =>
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr create" } }),
      loadRun: async () => {
        throw new BrokenRunStateError("runs/ghost");
      },
    });
    expect(code).toBe(EXIT.ERROR);
  });

  it("malformed stdin → ERROR (deny)", async () => {
    const code = await runPipelineGuards([], { readRaw: async () => "{not json" });
    expect(code).toBe(EXIT.ERROR);
  });

  it("no active run → OK", async () => {
    const code = await runPipelineGuards([], {
      readRaw: async () => JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" } }),
      loadRun: withRun(null),
    });
    expect(code).toBe(EXIT.OK);
  });
});
