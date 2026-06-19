import { describe, it, expect } from "vitest";
import { runStagingBranch, resolveStagingBranch, RUN_STAGING_PREFIX } from "./run-staging.js";

describe("runStagingBranch", () => {
  it("derives staging-<run-id> (hyphen, not slash — avoids the refs/heads/staging collision)", () => {
    expect(runStagingBranch("run-20260618-101500")).toBe("staging-run-20260618-101500");
  });
  it("uses the shared prefix constant with a hyphen delimiter", () => {
    expect(runStagingBranch("run-x")).toBe(`${RUN_STAGING_PREFIX}-run-x`);
  });
  it("never produces a slashed ref that would collide with a literal staging branch", () => {
    expect(runStagingBranch("run-x")).not.toContain("/");
  });
  it("rejects an empty run id (loud, not a bare 'staging-')", () => {
    expect(() => runStagingBranch("")).toThrow(/run id/i);
  });
});

describe("resolveStagingBranch", () => {
  it("returns the PINNED branch when present (defends against a mid-run recompute drift)", () => {
    // A run created before a naming-scheme change keeps the branch it actually cut.
    expect(resolveStagingBranch("run-1", "staging-run-1")).toBe("staging-run-1");
    expect(resolveStagingBranch("run-1", "staging/legacy-slashed")).toBe("staging/legacy-slashed");
  });
  it("falls back to the computed staging-<run-id> when unpinned (legacy runs)", () => {
    expect(resolveStagingBranch("run-1")).toBe("staging-run-1");
    expect(resolveStagingBranch("run-1", undefined)).toBe("staging-run-1");
  });
  it("treats a blank pinned value as unset (falls back to the computed name)", () => {
    expect(resolveStagingBranch("run-1", "")).toBe("staging-run-1");
  });
  it("propagates the empty-run-id loud failure through the fallback path", () => {
    expect(() => resolveStagingBranch("")).toThrow(/run id/i);
  });
});
