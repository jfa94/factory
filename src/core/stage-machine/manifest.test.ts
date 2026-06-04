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
    const m = parseSpawnManifest({ stage_after: "verify", agents: [validAgent] });
    expect(m.stage_after).toBe("verify");
    expect(m.agents).toHaveLength(1);
    expect(m.agents[0]?.isolation).toBe("worktree"); // default applied
    expect(m.agents[0]?.role).toBe("implementation-reviewer");
  });

  it("honours an explicit isolation override", () => {
    const m = parseSpawnManifest({
      stage_after: "exec",
      agents: [{ ...validAgent, role: "executor", isolation: "none" }],
    });
    expect(m.agents[0]?.isolation).toBe("none");
  });

  it("rejects an empty agents array (loud)", () => {
    expect(() => parseSpawnManifest({ stage_after: "exec", agents: [] })).toThrow();
  });

  it("rejects an unknown role (loud)", () => {
    expect(() =>
      parseSpawnManifest({
        stage_after: "exec",
        agents: [{ ...validAgent, role: "task-executor" }],
      }),
    ).toThrow();
  });

  it("rejects a bad stage_after (loud)", () => {
    expect(() => parseSpawnManifest({ stage_after: "finalize", agents: [validAgent] })).toThrow();
    expect(() => parseSpawnManifest({ stage_after: "postexec", agents: [validAgent] })).toThrow();
  });

  it("rejects a non-positive max_turns and empty prompt_ref (loud)", () => {
    expect(() =>
      parseSpawnManifest({ stage_after: "exec", agents: [{ ...validAgent, max_turns: 0 }] }),
    ).toThrow();
    expect(() =>
      parseSpawnManifest({ stage_after: "exec", agents: [{ ...validAgent, prompt_ref: "" }] }),
    ).toThrow();
  });

  it("SpawnManifestSchema is the same validator", () => {
    expect(
      SpawnManifestSchema.safeParse({ stage_after: "tests", agents: [validAgent] }).success,
    ).toBe(true);
  });
});
