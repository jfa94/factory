import { describe, expect, it } from "vitest";
import { parseSpawnRequest, SpawnRequestSchema } from "./spawn.js";

const validAgent = {
  role: "implementation-reviewer",
  model: "opus",
  max_turns: 40,
  prompt_ref: "reviews/impl.md",
};

describe("parseSpawnRequest", () => {
  it("accepts a valid request and applies the isolation default", () => {
    const m = parseSpawnRequest({ resume_phase: "verify", agents: [validAgent] });
    expect(m.resume_phase).toBe("verify");
    expect(m.agents).toHaveLength(1);
    expect(m.agents[0]?.isolation).toBe("worktree"); // default applied
    expect(m.agents[0]?.role).toBe("implementation-reviewer");
  });

  it("honours an explicit isolation override", () => {
    const m = parseSpawnRequest({
      resume_phase: "exec",
      agents: [{ ...validAgent, role: "executor", isolation: "none" }],
    });
    expect(m.agents[0]?.isolation).toBe("none");
  });

  it("rejects an empty agents array (loud)", () => {
    expect(() => parseSpawnRequest({ resume_phase: "exec", agents: [] })).toThrow();
  });

  it("rejects an unknown role (loud)", () => {
    expect(() =>
      parseSpawnRequest({
        resume_phase: "exec",
        agents: [{ ...validAgent, role: "task-executor" }],
      }),
    ).toThrow();
  });

  it("rejects a bad resume_phase (loud)", () => {
    expect(() => parseSpawnRequest({ resume_phase: "finalize", agents: [validAgent] })).toThrow();
    expect(() => parseSpawnRequest({ resume_phase: "postexec", agents: [validAgent] })).toThrow();
  });

  it("rejects a non-positive max_turns and empty prompt_ref (loud)", () => {
    expect(() =>
      parseSpawnRequest({ resume_phase: "exec", agents: [{ ...validAgent, max_turns: 0 }] }),
    ).toThrow();
    expect(() =>
      parseSpawnRequest({ resume_phase: "exec", agents: [{ ...validAgent, prompt_ref: "" }] }),
    ).toThrow();
  });

  it("accepts an optional effort and rejects an empty one (loud)", () => {
    const withEffort = parseSpawnRequest({
      resume_phase: "exec",
      agents: [{ ...validAgent, role: "executor", effort: "xhigh" }],
    });
    expect(withEffort.agents[0]?.effort).toBe("xhigh");
    // Omitted ⇒ undefined (inherit the spawn default), never coerced to a value.
    const noEffort = parseSpawnRequest({ resume_phase: "exec", agents: [validAgent] });
    expect(noEffort.agents[0]?.effort).toBeUndefined();
    // An empty effort is a loud parse error (min(1)) — not a silent passthrough.
    expect(() =>
      parseSpawnRequest({ resume_phase: "exec", agents: [{ ...validAgent, effort: "" }] }),
    ).toThrow();
  });

  it("SpawnRequestSchema is the same validator", () => {
    expect(
      SpawnRequestSchema.safeParse({ resume_phase: "tests", agents: [validAgent] }).success,
    ).toBe(true);
  });
});
