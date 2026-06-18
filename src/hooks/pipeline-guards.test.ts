/**
 * WS9 — pipeline-invariant guard tests (Δ V + Decision 1: derive-don't-store).
 *
 * The load-bearing property: ship admission (`gh pr create`/`gh pr merge`) is
 * decided by a verdict DERIVED from ground truth (reviewer array + injected gate
 * evidence) — there is no stored gate boolean, so a forged state field cannot
 * open the gate. Also covers: no active run → pass through; test-writer phase
 * write-scope; nested-shell denial while a run is active; dangling-symlink fail
 * closed via runPipelineGuards.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { decidePipelineGuards, runPipelineGuards } from "./pipeline-guards.js";
import { BrokenRunStateError, type ActiveRun } from "./hook-context.js";
import { parseHookInput, isDeny } from "./hook-io.js";
import { EXIT } from "../cli/exit-codes.js";
import type { GateEvidence } from "../core/state/index.js";
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
    driver: "balanced",
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
const BLOCKED = { reviewer: "quality", verdict: "blocked", confirmed_blockers: 1 } as const;
const GATE_OK: GateEvidence[] = [{ gate: "tests", observed: true }];
const GATE_FAIL: GateEvidence[] = [{ gate: "tests", observed: false }];

describe("pipeline-guards — no active run passes through", () => {
  it("allows any write when there is no active run", async () => {
    const d = await decidePipelineGuards(write("/repo/src/x.ts"), { loadRun: withRun(null) });
    expect(isDeny(d)).toBe(false);
  });
});

describe("pipeline-guards — ship gating is DERIVED (Δ V / D1)", () => {
  it("gh pr create ALLOWED only when derived floor passes (gates+panel)", async () => {
    const run = activeRun({ t1: task({ reviewers: [APPROVE] }) });
    const d = await decidePipelineGuards(bash("gh pr create --fill"), {
      loadRun: withRun(run),
      gateEvidence: { t1: GATE_OK },
    });
    expect(isDeny(d)).toBe(false);
  });

  it("gh pr create BLOCKED when panel approves but gate evidence fails", async () => {
    const run = activeRun({ t1: task({ reviewers: [APPROVE] }) });
    const d = await decidePipelineGuards(bash("gh pr create --fill"), {
      loadRun: withRun(run),
      gateEvidence: { t1: GATE_FAIL },
    });
    expect(isDeny(d)).toBe(true);
  });

  it("gh pr create BLOCKED when gates pass but a reviewer is blocked", async () => {
    const run = activeRun({ t1: task({ reviewers: [BLOCKED] }) });
    const d = await decidePipelineGuards(bash("gh pr create --fill"), {
      loadRun: withRun(run),
      gateEvidence: { t1: GATE_OK },
    });
    expect(isDeny(d)).toBe(true);
  });

  it("gh pr create BLOCKED with NO gate evidence (empty set fails closed)", async () => {
    const run = activeRun({ t1: task({ reviewers: [APPROVE] }) });
    const d = await decidePipelineGuards(bash("gh pr create --fill"), {
      loadRun: withRun(run),
      // gateEvidence omitted → empty set → floor fails
    });
    expect(isDeny(d)).toBe(true);
  });

  // Regression: a prefixed/compound command must NOT evade the ship gate by
  // command composition (the `^\s*` anchor used to let these through as "not a
  // ship command" → allow; boundary-aware detection now subjects them to the floor).
  it.each([
    "cd /repo && gh pr create --fill",
    "true; gh pr create --fill",
    "GH=1 gh pr create --fill",
    "echo hi | gh pr create --fill",
  ])(
    "compound command '%s' is still subject to the floor (BLOCKED on a failed floor)",
    async (cmd) => {
      const run = activeRun({ t1: task({ reviewers: [BLOCKED] }) });
      const d = await decidePipelineGuards(bash(cmd), {
        loadRun: withRun(run),
        gateEvidence: { t1: GATE_OK },
      });
      expect(isDeny(d)).toBe(true);
    },
  );

  it("a compound gh pr create with a PASSING floor is still allowed (no over-block)", async () => {
    const run = activeRun({ t1: task({ reviewers: [APPROVE] }) });
    const d = await decidePipelineGuards(bash("cd /repo && gh pr create --fill"), {
      loadRun: withRun(run),
      gateEvidence: { t1: GATE_OK },
    });
    expect(isDeny(d)).toBe(false);
  });

  it("gh pr merge ALLOWED only with unanimous panel + pr_number + green CI", async () => {
    const run = activeRun({ t1: task({ reviewers: [APPROVE], pr_number: 42 }) });
    const d = await decidePipelineGuards(bash("gh pr merge 42 --squash"), {
      loadRun: withRun(run),
      gateEvidence: { t1: GATE_OK },
    });
    expect(isDeny(d)).toBe(false);
  });

  it("gh pr merge BLOCKED when pr_number is absent", async () => {
    const run = activeRun({ t1: task({ reviewers: [APPROVE] }) });
    const d = await decidePipelineGuards(bash("gh pr merge --squash"), {
      loadRun: withRun(run),
      gateEvidence: { t1: GATE_OK },
    });
    expect(isDeny(d)).toBe(true);
  });

  it("gh pr merge BLOCKED when panel not unanimous", async () => {
    const run = activeRun({ t1: task({ reviewers: [BLOCKED], pr_number: 42 }) });
    const d = await decidePipelineGuards(bash("gh pr merge 42 --squash"), {
      loadRun: withRun(run),
      gateEvidence: { t1: GATE_OK },
    });
    expect(isDeny(d)).toBe(true);
  });

  it("gh pr merge BLOCKED when CI/floor evidence is not green", async () => {
    const run = activeRun({ t1: task({ reviewers: [APPROVE], pr_number: 42 }) });
    const d = await decidePipelineGuards(bash("gh pr merge 42 --squash"), {
      loadRun: withRun(run),
      gateEvidence: { t1: GATE_FAIL },
    });
    expect(isDeny(d)).toBe(true);
  });

  it("a forged task field cannot open the gate (no stored boolean exists to read)", async () => {
    // The task carries NO approving reviewers; whatever extra fields a forger
    // adds, the derived verdict still sees an empty reviewer set → fail.
    const run = activeRun({ t1: task({ reviewers: [] }) });
    const d = await decidePipelineGuards(bash("gh pr create --fill"), {
      loadRun: withRun(run),
      gateEvidence: { t1: GATE_OK },
    });
    expect(isDeny(d)).toBe(true);
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

  it("allows an implementation write during the executor (GREEN) phase", async () => {
    const run = runState({ t1: task({ status: "executing", producer_role: "executor" }) });
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
