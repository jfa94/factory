import { describe, expect, it } from "vitest";
import {
  advance,
  spawn,
  gracefulStop,
  waitRetry,
  taskDone,
  taskFailed,
  finalizeTerminal,
  assertNever,
  isTerminalResult,
  type PhaseResult,
} from "./result.js";
import type { SpawnRequest } from "./spawn.js";

const request: SpawnRequest = {
  resume_phase: "exec",
  agents: [
    { role: "implementer", isolation: "worktree", model: "sonnet", max_turns: 60, prompt_ref: "p.md" },
  ],
};

describe("PhaseResult constructors build correct discriminants", () => {
  it("advance carries the target phase", () => {
    expect(advance("verify")).toEqual({ kind: "advance", to: "verify" });
  });

  it("spawn wraps a request", () => {
    expect(spawn(request)).toEqual({ kind: "spawn-agents", request });
  });

  it("gracefulStop omits resets_at_epoch when undefined", () => {
    expect(gracefulStop("5h", "quota")).toEqual({
      kind: "graceful-stop",
      scope: "5h",
      reason: "quota",
    });
    expect(gracefulStop("7d", "quota", 123)).toEqual({
      kind: "graceful-stop",
      scope: "7d",
      reason: "quota",
      resets_at_epoch: 123,
    });
  });

  it("waitRetry carries the bound fields", () => {
    expect(waitRetry("ship", "ci flaky", 2, 3)).toEqual({
      kind: "wait-retry",
      phase: "ship",
      reason: "ci flaky",
      attempt: 2,
      max_attempts: 3,
    });
  });

  it("taskDone / taskFailed build the nested outcome", () => {
    expect(taskDone()).toEqual({ kind: "task-terminal", outcome: { outcome: "done" } });
    expect(taskFailed("capability-budget", "exhausted")).toEqual({
      kind: "task-terminal",
      outcome: { outcome: "failed", failure_class: "capability-budget", reason: "exhausted" },
    });
  });

  it("finalizeTerminal carries the run status", () => {
    expect(finalizeTerminal("failed")).toEqual({
      kind: "finalize-terminal",
      run_status: "failed",
    });
  });
});

describe("assertNever", () => {
  it("throws loudly when reached at runtime", () => {
    // Force an unhandled value through the `never` parameter (simulates an
    // unknown kind reaching the default branch).
    expect(() => assertNever("bogus" as never)).toThrow(/unhandled value/);
  });
});

describe("isTerminalResult", () => {
  it("classifies each kind correctly", () => {
    const terminal: PhaseResult[] = [
      taskDone(),
      taskFailed("spec-defect", "bad spec"),
      finalizeTerminal("completed"),
      gracefulStop("7d", "quota"),
    ];
    const continuation: PhaseResult[] = [
      advance("tests"),
      spawn(request),
      waitRetry("ship", "wait", 1, 3),
    ];
    for (const r of terminal) expect(isTerminalResult(r)).toBe(true);
    for (const r of continuation) expect(isTerminalResult(r)).toBe(false);
  });

  it("throws on an unknown kind (never silently classifies)", () => {
    expect(() => isTerminalResult({ kind: "made-up" } as unknown as PhaseResult)).toThrow(
      /unhandled value/,
    );
  });
});
