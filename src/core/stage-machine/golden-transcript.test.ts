/**
 * WS2 — THE acceptance harness. A canned 2-task run (one ships, one drops) driven
 * through the engine by FULLY-FAKE handlers, asserting a FIXED StageResult
 * SEQUENCE. This is the golden contract: if the engine's dispatch or a result
 * shape drifts, the recorded transcript diverges.
 *
 * It exercises every acceptance criterion in one place:
 *   - the full per-task walk preflight→tests→exec→verify→ship for each task,
 *   - a `spawn-agents` at tests / exec / verify,
 *   - a `task-terminal(done)` and a `task-terminal(dropped, capability-budget)`,
 *   - a run-level `finalize-terminal(partial)` (NOT wait-retry) for the incomplete
 *     (one-dropped) run,
 *   - finalize THROWS on a leftover non-terminal task (anti-spin).
 */
import { describe, expect, it } from "vitest";
import { runStage, nextStageFor, decideFinalize, type EngineStage } from "./engine.js";
import { advance, spawn, taskDone, taskDropped, type StageResult } from "./result.js";
import type { StageContext, StageHandlers } from "./handlers.js";
import type { SpawnManifest } from "./manifest.js";
import { parseRunState, type RunState } from "../state/index.js";

// --- canned spec: two tasks ---------------------------------------------------

const mkManifest = (
  stage_after: SpawnManifest["stage_after"],
  role: SpawnManifest["agents"][number]["role"],
): SpawnManifest => ({
  stage_after,
  agents: [
    {
      role,
      isolation: "worktree",
      model: "sonnet",
      max_turns: 60,
      prompt_ref: `prompts/${role}.md`,
    },
  ],
});

/**
 * Fake handlers that drive a task to a desired outcome via a fixed script. The
 * "happy" task spawns at tests/exec/verify then ships to done. The "drop" task
 * spawns at tests then the exec stage classifies a capability-budget drop.
 */
function scriptedHandlers(outcome: "ship" | "drop"): StageHandlers {
  const finalize: StageHandlers["finalize"] = async (ctx) => decideFinalize(ctx.run);
  if (outcome === "ship") {
    return {
      preflight: async () => advance("tests"),
      tests: async () => spawn(mkManifest("exec", "test-writer")),
      exec: async () => spawn(mkManifest("verify", "executor")),
      verify: async () => spawn(mkManifest("ship", "implementation-reviewer")),
      ship: async () => taskDone(),
      finalize,
    };
  }
  return {
    preflight: async () => advance("tests"),
    tests: async () => spawn(mkManifest("exec", "test-writer")),
    exec: async () => taskDropped("capability-budget", "producer ladder exhausted"),
    verify: async () => taskDone(),
    ship: async () => taskDone(),
    finalize,
  };
}

/**
 * Drive ONE task from preflight to a terminal result, recording each
 * StageResult. Uses the engine's own nextStageFor to compute the resume stage —
 * so the transcript also asserts the shared transition logic.
 */
async function driveTask(handlers: StageHandlers, ctx: StageContext): Promise<StageResult[]> {
  const transcript: StageResult[] = [];
  let stage: EngineStage | null = "preflight";
  while (stage !== null) {
    const r: StageResult = await runStage(stage, ctx, handlers);
    transcript.push(r);
    if (r.kind === "task-terminal") break;
    const next = nextStageFor(r); // advance.to or manifest.stage_after
    stage = next;
  }
  return transcript;
}

const baseRun = (tasks: Record<string, unknown>): RunState =>
  parseRunState({
    run_id: "run-20260604-120000",
    spec: { repo: "o/r", spec_id: "1-golden", issue_number: 1 },
    started_at: "2026-06-04T12:00:00.000Z",
    updated_at: "2026-06-04T12:00:00.000Z",
    tasks,
  });

describe("golden transcript — fixed StageResult sequence", () => {
  it("the happy task walks preflight→tests→exec→verify→ship to task-terminal(done)", async () => {
    const ctx: StageContext = {
      run: baseRun({ a: { task_id: "a", status: "pending", risk_tier: "low" } }),
    };
    const transcript = await driveTask(scriptedHandlers("ship"), ctx);

    expect(transcript).toEqual([
      advance("tests"),
      spawn(mkManifest("exec", "test-writer")),
      spawn(mkManifest("verify", "executor")),
      spawn(mkManifest("ship", "implementation-reviewer")),
      taskDone(),
    ]);
  });

  it("the drop task reaches task-terminal(dropped, capability-budget)", async () => {
    const ctx: StageContext = {
      run: baseRun({ b: { task_id: "b", status: "pending", risk_tier: "low" } }),
    };
    const transcript = await driveTask(scriptedHandlers("drop"), ctx);

    expect(transcript).toEqual([
      advance("tests"),
      spawn(mkManifest("exec", "test-writer")),
      taskDropped("capability-budget", "producer ladder exhausted"),
    ]);
  });

  it("the run-level finalize over {done, dropped} is finalize-terminal(partial), never wait-retry", async () => {
    // Both tasks now terminal: a shipped, b dropped.
    const ctx: StageContext = {
      run: baseRun({
        a: { task_id: "a", status: "done", risk_tier: "low" },
        b: {
          task_id: "b",
          status: "dropped",
          risk_tier: "low",
          failure_class: "capability-budget",
          failure_reason: "producer ladder exhausted",
        },
      }),
    };
    const r = await runStage("finalize", ctx, scriptedHandlers("ship"));
    expect(r).toEqual({ kind: "finalize-terminal", run_status: "partial" });
    expect(r.kind).not.toBe("wait-retry");
  });

  it("finalize over an incomplete (non-terminal) run THROWS, never spins", async () => {
    const ctx: StageContext = {
      run: baseRun({
        a: { task_id: "a", status: "done", risk_tier: "low" },
        b: { task_id: "b", status: "executing", risk_tier: "low" },
      }),
    };
    await expect(runStage("finalize", ctx, scriptedHandlers("ship"))).rejects.toThrow(
      /non-terminal task/,
    );
  });
});
