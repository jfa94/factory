import { describe, it, expect } from "vitest";
import { runStagingBranch, RUN_STAGING_PREFIX } from "./run-staging.js";

describe("runStagingBranch", () => {
  it("derives staging/<run-id>", () => {
    expect(runStagingBranch("run-20260618-101500")).toBe("staging/run-20260618-101500");
  });
  it("uses the shared prefix constant", () => {
    expect(runStagingBranch("run-x")).toBe(`${RUN_STAGING_PREFIX}/run-x`);
  });
  it("rejects an empty run id (loud, not a bare 'staging/')", () => {
    expect(() => runStagingBranch("")).toThrow(/run id/i);
  });
});
