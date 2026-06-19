import { describe, it, expect } from "vitest";
import { runStagingBranch, RUN_STAGING_PREFIX } from "./run-staging.js";

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
