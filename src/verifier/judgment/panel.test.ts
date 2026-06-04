import { describe, it, expect } from "vitest";
import { RiskTierEnum, parseSpawnManifest, type RiskTier } from "../../types/index.js";
import { PANEL_ROLES, buildPanelManifest } from "./panel.js";

const ALL_TIERS: readonly RiskTier[] = RiskTierEnum.options;

describe("WS7 risk-invariant panel (D26 / Δ T)", () => {
  it("Δ K: panel is EXACTLY the 6 fixed CCR-pattern roles", () => {
    expect([...PANEL_ROLES].sort()).toEqual(
      [
        "architecture-reviewer",
        "implementation-reviewer",
        "quality-reviewer",
        "security-reviewer",
        "silent-failure-hunter",
        "type-design-reviewer",
      ].sort(),
    );
    expect(PANEL_ROLES.length).toBe(6);
  });

  it("D26 / Δ T: membership, model, and max_turns are IDENTICAL across all risk tiers", () => {
    // The function has no RiskTier parameter — invariance is structural. We prove
    // it by building one manifest per tier (membership is the SAME regardless) and
    // asserting deep equality. Exhaustive over the closed RiskTier set (= property
    // test over the finite domain; fast-check is not a dep here).
    const manifests = ALL_TIERS.map(() => buildPanelManifest("verify", "opus", 40));
    const first = manifests[0]!;
    for (const m of manifests) {
      expect(m).toEqual(first);
    }
    // And the model is a SINGLE fixed value for every reviewer.
    const models = new Set(first.agents.map((a) => a.model));
    expect(models.size).toBe(1);
    expect([...models][0]!).toBe("opus");
    // Fixed depth: one max_turns for all.
    const turns = new Set(first.agents.map((a) => a.max_turns));
    expect(turns.size).toBe(1);
    expect([...turns][0]!).toBe(40);
  });

  it("D26: every panel role appears exactly once in the manifest", () => {
    const m = buildPanelManifest("verify", "opus", 40);
    const roles = m.agents.map((a) => a.role).sort();
    expect(roles).toEqual([...PANEL_ROLES].sort());
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("WS2 coherence: the manifest validates through the frozen parseSpawnManifest", () => {
    const m = buildPanelManifest("verify", "opus", 40);
    expect(() => parseSpawnManifest(m)).not.toThrow();
    expect(m.stage_after).toBe("verify");
  });

  it("Δ T: a blank model fails LOUD at the seam (no malformed manifest)", () => {
    expect(() => buildPanelManifest("verify", "", 40)).toThrow();
  });

  it("D26: a non-positive max_turns fails LOUD at the seam", () => {
    expect(() => buildPanelManifest("verify", "opus", 0)).toThrow();
  });
});
