import { describe, expect, it, vi } from "vitest";
import { runStage, nextStageFor, decideFinalize, StageEngine } from "./engine.js";
import {
  advance,
  spawn,
  gracefulStop,
  waitRetry,
  taskDone,
  finalizeTerminal,
  type StageResult,
} from "./result.js";
import type { StageContext, StageHandlers } from "./handlers.js";
import { parseRunState, type RunState } from "../state/index.js";

const ctx: StageContext = {
  run: parseRunState({
    run_id: "run-20260604-000000",
    spec: { repo: "o/r", spec_id: "1-x", issue_number: 1 },
    started_at: "2026-06-04T00:00:00.000Z",
    updated_at: "2026-06-04T00:00:00.000Z",
    tasks: {},
  }),
};

/** A handler set where every method records its call and returns a canned result. */
function fakeHandlers(overrides: Partial<StageHandlers> = {}): StageHandlers {
  return {
    preflight: vi.fn(async () => advance("tests")),
    tests: vi.fn(async () => advance("exec")),
    exec: vi.fn(async () => advance("verify")),
    verify: vi.fn(async () => advance("ship")),
    ship: vi.fn(async () => taskDone()),
    finalize: vi.fn(async () => finalizeTerminal("completed")),
    ...overrides,
  };
}

describe("runStage dispatch", () => {
  it("calls the matching handler for each per-task stage", async () => {
    const h = fakeHandlers();
    await runStage("preflight", ctx, h);
    await runStage("tests", ctx, h);
    await runStage("exec", ctx, h);
    await runStage("verify", ctx, h);
    await runStage("ship", ctx, h);
    expect(h.preflight).toHaveBeenCalledTimes(1);
    expect(h.tests).toHaveBeenCalledTimes(1);
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.ship).toHaveBeenCalledTimes(1);
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it("routes the run-level finalize stage to the finalize handler", async () => {
    const h = fakeHandlers();
    const r = await runStage("finalize", ctx, h);
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(r).toEqual(finalizeTerminal("completed"));
  });

  it("throws on an unknown stage value", async () => {
    const h = fakeHandlers();
    await expect(runStage("bogus" as never, ctx, h)).rejects.toThrow(/unknown stage/);
  });
});

describe("invariant #1 — unknown StageResult.kind THROWS, never advances", () => {
  it("a handler returning an unhandled kind makes the engine throw", async () => {
    const h = fakeHandlers({
      tests: async () => ({ kind: "bogus" }) as unknown as StageResult,
    });
    await expect(runStage("tests", ctx, h)).rejects.toThrow(/unhandled value/);
  });
});

describe("invariant #2 — bounded wait-retry", () => {
  it("attempt within bound is returned", async () => {
    const h = fakeHandlers({ ship: async () => waitRetry("ship", "ci", 2, 3) });
    const r = await runStage("ship", ctx, h);
    expect(r.kind).toBe("wait-retry");
  });

  it("attempt === max_attempts is the last legal retry (boundary, not a throw)", async () => {
    const h = fakeHandlers({ ship: async () => waitRetry("ship", "ci", 3, 3) });
    const r = await runStage("ship", ctx, h);
    expect(r).toEqual(waitRetry("ship", "ci", 3, 3));
  });

  it("attempt > max_attempts THROWS (never spins)", async () => {
    const h = fakeHandlers({ ship: async () => waitRetry("ship", "ci", 4, 3) });
    await expect(runStage("ship", ctx, h)).rejects.toThrow(/exceeded max_attempts/);
  });

  it("a wait-retry from finalize is rejected (finalize must never spin)", async () => {
    const h = fakeHandlers({ finalize: async () => waitRetry("ship", "x", 1, 3) });
    await expect(runStage("finalize", ctx, h)).rejects.toThrow(/finalize is terminal/);
  });
});

describe("graceful-stop is accepted from a per-task stage (quota breach, never a drop)", () => {
  it("a per-task stage returning graceful-stop is surfaced unchanged", async () => {
    const h = fakeHandlers({ exec: async () => gracefulStop("5h", "5h window breached") });
    const r = await runStage("exec", ctx, h);
    expect(r).toEqual(gracefulStop("5h", "5h window breached"));
    expect(nextStageFor(r)).toBeNull();
  });

  it("graceful-stop from finalize is rejected (finalize returns only finalize-terminal)", async () => {
    const h = fakeHandlers({ finalize: async () => gracefulStop("7d", "7d window breached") });
    await expect(runStage("finalize", ctx, h)).rejects.toThrow(/finalize is terminal/);
  });
});

describe("invariant #3 — finalize is terminal-by-construction at the seam", () => {
  it("finalize returning advance is rejected (only finalize-terminal is legal)", async () => {
    const h = fakeHandlers({ finalize: async () => advance("ship") });
    await expect(runStage("finalize", ctx, h)).rejects.toThrow(/finalize is terminal/);
  });

  it("finalize returning spawn-agents is rejected", async () => {
    const h = fakeHandlers({
      finalize: async () =>
        spawn({
          stage_after: "exec",
          agents: [
            { role: "executor", isolation: "worktree", model: "s", max_turns: 1, prompt_ref: "p" },
          ],
        }),
    });
    await expect(runStage("finalize", ctx, h)).rejects.toThrow(/finalize is terminal/);
  });

  it("finalize returning task-terminal is rejected", async () => {
    const h = fakeHandlers({ finalize: async () => taskDone() });
    await expect(runStage("finalize", ctx, h)).rejects.toThrow(/finalize is terminal/);
  });

  it("finalize returning finalize-terminal is accepted", async () => {
    const h = fakeHandlers({ finalize: async () => finalizeTerminal("failed") });
    const r = await runStage("finalize", ctx, h);
    expect(r).toEqual(finalizeTerminal("failed"));
  });

  it("a per-task stage returning finalize-terminal is rejected (reserved for finalize)", async () => {
    const h = fakeHandlers({ ship: async () => finalizeTerminal("completed") });
    await expect(runStage("ship", ctx, h)).rejects.toThrow(/reserved for the run-level finalize/);
  });
});

describe("nextStageFor", () => {
  it("advance resumes at .to; spawn-agents resumes at manifest.stage_after", () => {
    expect(nextStageFor(advance("verify"))).toBe("verify");
    expect(
      nextStageFor(
        spawn({
          stage_after: "exec",
          agents: [
            { role: "executor", isolation: "worktree", model: "s", max_turns: 1, prompt_ref: "p" },
          ],
        }),
      ),
    ).toBe("exec");
  });

  it("terminals / wait-retry / graceful-stop imply no resume stage", () => {
    expect(nextStageFor(taskDone())).toBeNull();
    expect(nextStageFor(finalizeTerminal("failed"))).toBeNull();
    expect(nextStageFor(waitRetry("ship", "x", 1, 3))).toBeNull();
  });
});

describe("StageEngine class wrapper", () => {
  it("binds handlers and delegates to runStage / nextStageFor", async () => {
    const h = fakeHandlers();
    const engine = new StageEngine(h);
    const r = await engine.run("preflight", ctx);
    expect(r).toEqual(advance("tests"));
    expect(engine.nextStageFor(r)).toBe("tests");
  });
});

describe("decideFinalize is pure + terminal-by-construction", () => {
  const mkRun = (tasks: Record<string, unknown>): RunState =>
    parseRunState({
      run_id: "run-20260604-000000",
      spec: { repo: "o/r", spec_id: "1-x", issue_number: 1 },
      started_at: "2026-06-04T00:00:00.000Z",
      updated_at: "2026-06-04T00:00:00.000Z",
      tasks,
    });

  it("all done → completed", () => {
    const run = mkRun({
      a: { task_id: "a", status: "done", risk_tier: "low" },
      b: { task_id: "b", status: "done", risk_tier: "low" },
    });
    expect(decideFinalize(run)).toEqual(finalizeTerminal("completed"));
  });

  it("some done + some dropped → failed (develop gets nothing, Decision 34)", () => {
    const run = mkRun({
      a: { task_id: "a", status: "done", risk_tier: "low" },
      b: {
        task_id: "b",
        status: "dropped",
        risk_tier: "low",
        failure_class: "spec-defect",
        failure_reason: "untestable criterion",
      },
    });
    expect(decideFinalize(run)).toEqual(finalizeTerminal("failed"));
  });

  it("zero done → failed (no partial delivery)", () => {
    const run = mkRun({
      a: {
        task_id: "a",
        status: "dropped",
        risk_tier: "low",
        failure_class: "capability-budget",
        failure_reason: "producer ladder exhausted",
      },
    });
    expect(decideFinalize(run)).toEqual(finalizeTerminal("failed"));
  });

  it("0 done → failed", () => {
    const run = mkRun({
      a: {
        task_id: "a",
        status: "dropped",
        risk_tier: "low",
        failure_class: "capability-budget",
        failure_reason: "producer ladder exhausted",
      },
    });
    expect(decideFinalize(run)).toEqual(finalizeTerminal("failed"));
  });

  it("empty task set → failed (nothing shippable)", () => {
    expect(decideFinalize(mkRun({}))).toEqual(finalizeTerminal("failed"));
  });

  it("a non-terminal task THROWS, never wait-retry (anti-spin)", () => {
    const run = mkRun({
      a: { task_id: "a", status: "done", risk_tier: "low" },
      b: { task_id: "b", status: "reviewing", risk_tier: "low" },
    });
    expect(() => decideFinalize(run)).toThrow(/non-terminal task/);
  });
});
