import { describe, it, expect } from "vitest";
import { RiskTierEnum, parseSpawnRequest, type RiskTier } from "../../types/index.js";
import { PANEL_ROLES, buildPanelManifest } from "./panel.js";

const ALL_TIERS: readonly RiskTier[] = RiskTierEnum.options;

describe("WS7 risk-invariant panel (D26 / Δ T)", () => {
  it("D43: panel is EXACTLY the 4 fixed consolidated roles", () => {
    expect([...PANEL_ROLES].sort()).toEqual(
      [
        "implementation-reviewer",
        "quality-reviewer",
        "silent-failure-hunter",
        "systemic-failure-reviewer",
      ].sort(),
    );
    expect(PANEL_ROLES.length).toBe(4);
  });

  it("D26 / Δ T: membership, model, and max_turns are IDENTICAL across all risk tiers", () => {
    // The function has no RiskTier parameter — invariance is structural. We prove
    // it by building one request per tier (membership is the SAME regardless) and
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

  it("D26: every panel role appears exactly once in the request", () => {
    const m = buildPanelManifest("verify", "opus", 40);
    const roles = m.agents.map((a) => a.role).sort();
    expect(roles).toEqual([...PANEL_ROLES].sort());
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("WS2 coherence: the request validates through the frozen parseSpawnRequest", () => {
    const m = buildPanelManifest("verify", "opus", 40);
    expect(() => parseSpawnRequest(m)).not.toThrow();
    expect(m.resume_phase).toBe("verify");
  });

  it("Δ T: a blank model fails LOUD at the seam (no malformed request)", () => {
    expect(() => buildPanelManifest("verify", "", 40)).toThrow();
  });

  it("D26: a non-positive max_turns fails LOUD at the seam", () => {
    expect(() => buildPanelManifest("verify", "opus", 0)).toThrow();
  });

  describe("S5/C cross-vendor stamp", () => {
    it("present resolution stamps { status: 'present', model } from the slot", () => {
      const m = buildPanelManifest("verify", "opus", 40, {
        status: "present",
        slot: { vendor: "codex", model: "gpt-5-codex" },
      });
      expect(m.cross_vendor).toEqual({ status: "present", model: "gpt-5-codex" });
    });

    it("absent resolution stamps { status: 'absent', reason } verbatim", () => {
      const m = buildPanelManifest("verify", "opus", 40, {
        status: "absent",
        reason: "no cross-vendor model configured (codex.model)",
      });
      expect(m.cross_vendor).toEqual({
        status: "absent",
        reason: "no cross-vendor model configured (codex.model)",
      });
    });

    it("no resolution ⇒ no stamp (key absent, not undefined-valued)", () => {
      const m = buildPanelManifest("verify", "opus", 40);
      expect("cross_vendor" in m).toBe(false);
    });

    it("the stamp never changes panel membership, model, or turns", () => {
      const stamped = buildPanelManifest("verify", "opus", 40, {
        status: "absent",
        reason: "r",
      });
      const bare = buildPanelManifest("verify", "opus", 40);
      expect(stamped.agents).toEqual(bare.agents);
    });
  });
});
