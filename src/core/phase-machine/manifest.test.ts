import { describe, expect, it } from "vitest";
import { parseSpawnManifest, SpawnManifestSchema } from "./manifest.js";

const validAgent = {
  role: "implementation-reviewer",
  model: "opus",
  max_turns: 40,
  prompt_ref: "reviews/impl.md",
};

describe("parseSpawnManifest", () => {
  it("accepts a valid manifest and applies the isolation default", () => {
    const m = parseSpawnManifest({ resume_phase: "verify", agents: [validAgent] });
    expect(m.resume_phase).toBe("verify");
    expect(m.agents).toHaveLength(1);
    expect(m.agents[0]?.isolation).toBe("worktree"); // default applied
    expect(m.agents[0]?.role).toBe("implementation-reviewer");
  });

  it("honours an explicit isolation override", () => {
    const m = parseSpawnManifest({
      resume_phase: "exec",
      agents: [{ ...validAgent, role: "executor", isolation: "none" }],
    });
    expect(m.agents[0]?.isolation).toBe("none");
  });

  it("rejects an empty agents array (loud)", () => {
    expect(() => parseSpawnManifest({ resume_phase: "exec", agents: [] })).toThrow();
  });

  it("rejects an unknown role (loud)", () => {
    expect(() =>
      parseSpawnManifest({
        resume_phase: "exec",
        agents: [{ ...validAgent, role: "task-executor" }],
      }),
    ).toThrow();
  });

  it("rejects a bad resume_phase (loud)", () => {
    expect(() => parseSpawnManifest({ resume_phase: "finalize", agents: [validAgent] })).toThrow();
    expect(() => parseSpawnManifest({ resume_phase: "postexec", agents: [validAgent] })).toThrow();
  });

  it("rejects a non-positive max_turns and empty prompt_ref (loud)", () => {
    expect(() =>
      parseSpawnManifest({ resume_phase: "exec", agents: [{ ...validAgent, max_turns: 0 }] }),
    ).toThrow();
    expect(() =>
      parseSpawnManifest({ resume_phase: "exec", agents: [{ ...validAgent, prompt_ref: "" }] }),
    ).toThrow();
  });

  it("accepts an optional effort and rejects an empty one (loud)", () => {
    const withEffort = parseSpawnManifest({
      resume_phase: "exec",
      agents: [{ ...validAgent, role: "executor", effort: "xhigh" }],
    });
    expect(withEffort.agents[0]?.effort).toBe("xhigh");
    // Omitted ⇒ undefined (inherit the spawn default), never coerced to a value.
    const noEffort = parseSpawnManifest({ resume_phase: "exec", agents: [validAgent] });
    expect(noEffort.agents[0]?.effort).toBeUndefined();
    // An empty effort is a loud parse error (min(1)) — not a silent passthrough.
    expect(() =>
      parseSpawnManifest({ resume_phase: "exec", agents: [{ ...validAgent, effort: "" }] }),
    ).toThrow();
  });

  it("SpawnManifestSchema is the same validator", () => {
    expect(
      SpawnManifestSchema.safeParse({ resume_phase: "tests", agents: [validAgent] }).success,
    ).toBe(true);
  });
});
