import { describe, expect, it } from "vitest";
import {
  ProtectionMissingError,
  probeProtection,
  provisionProtection,
  requireProtectionOrRefuse,
} from "./protection.js";
import { FakeGhClient } from "./fakes.js";
import type { ProtectionApiResult } from "./gh-client.js";

const FULL: ProtectionApiResult = {
  enabled: true,
  requiredStatusChecks: ["ci", "lint"],
  strictUpToDate: true,
  hasMergeQueue: false,
};

describe("#2 / Δ A — branch-protection refuse-to-run gate", () => {
  it("refuses to run when NO branch protection exists (default verify-and-refuse)", async () => {
    const gh = new FakeGhClient(); // no protection seeded
    const state = await probeProtection({ ghClient: gh, owner: "o", repo: "r", branch: "staging" });
    expect(state.enabled).toBe(false);
    expect(() => requireProtectionOrRefuse(state, [], "staging")).toThrow(ProtectionMissingError);
  });

  it("refuses when strict-up-to-date is OFF (serial-writer backbone, Δ L)", () => {
    const state = { ...FULL, strictUpToDate: false };
    expect(() => requireProtectionOrRefuse(state, [], "staging")).toThrow(/strict/i);
  });

  it("refuses when a required status check is missing", () => {
    expect(() => requireProtectionOrRefuse(FULL, ["ci", "coverage"], "staging")).toThrow(
      /coverage/,
    );
  });

  it("passes when protection + strict + all required checks are present", () => {
    expect(requireProtectionOrRefuse(FULL, ["ci", "lint"], "staging")).toBe(FULL);
  });

  it("provisionProtection is NOT called unless --provision is set; with provision:false it throws", async () => {
    const gh = new FakeGhClient();
    await expect(
      provisionProtection({
        ghClient: gh,
        owner: "o",
        repo: "r",
        requiredChecks: ["ci"],
        provision: false,
      }),
    ).rejects.toThrow(/--provision/);
    expect(gh.calls.some((c) => c.startsWith("api PUT"))).toBe(false);
  });

  it("with --provision: issues the gh api PUT and a re-probe then passes", async () => {
    const gh = new FakeGhClient();
    const after = await provisionProtection({
      ghClient: gh,
      owner: "o",
      repo: "r",
      branch: "staging",
      requiredChecks: ["ci"],
      provision: true,
    });
    expect(gh.calls.some((c) => c.startsWith("api PUT protection staging"))).toBe(true);
    // The re-probe reflects the provisioned state and the gate now passes.
    expect(after.enabled).toBe(true);
    expect(after.strictUpToDate).toBe(true);
    expect(() => requireProtectionOrRefuse(after, ["ci"], "staging")).not.toThrow();
  });
});
