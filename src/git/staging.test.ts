import { describe, expect, it } from "vitest";
import { ensureStaging } from "./staging.js";
import { FakeGitClient } from "./fakes.js";

describe("staging-init / reconcile (never main fallback)", () => {
  it("creates staging from base when staging is absent", async () => {
    const git = new FakeGitClient({ remoteHeads: { develop: "sha-dev-1" } });
    const r = await ensureStaging({ gitClient: git });
    expect(r.created).toBe(true);
    // staging pushed to origin from develop
    expect(git.getRemoteHead("staging")).toBeDefined();
    expect(git.calls.some((c) => c.startsWith("checkout -B staging origin/develop"))).toBe(true);
  });

  it("fails loud when the base branch does not exist (no main fallback)", async () => {
    const git = new FakeGitClient({ remoteHeads: {} });
    await expect(ensureStaging({ gitClient: git })).rejects.toThrow(/base branch/i);
  });

  it("refuses a baseBranch of 'main'", async () => {
    const git = new FakeGitClient({ remoteHeads: { main: "x" } });
    await expect(ensureStaging({ gitClient: git, baseBranch: "main" })).rejects.toThrow(/main/);
  });

  it("no-op when staging tip already equals base tip", async () => {
    const git = new FakeGitClient({ remoteHeads: { develop: "sha-1", staging: "sha-1" } });
    const r = await ensureStaging({ gitClient: git });
    expect(r.created).toBe(false);
    expect(r.stagingTip).toBe("sha-1");
  });

  it("fast-forwards staging when base is strictly ahead", async () => {
    // merge-base(develop, staging) === staging tip → develop is ahead → FF.
    const git = new FakeGitClient();
    git.setRemoteHead("develop", "sha-dev-2");
    git.setRemoteHead("staging", "sha-stg-1");
    // make merge-base resolve to staging tip (staging is an ancestor of develop)
    git.mergeBase = async () => "sha-stg-1";
    const r = await ensureStaging({ gitClient: git });
    expect(r.created).toBe(false);
    expect(git.calls.some((c) => c.startsWith("checkout -B staging origin/develop"))).toBe(true);
  });

  it("leaves staging alone when it is ahead of base (normal mid-cycle)", async () => {
    const git = new FakeGitClient();
    git.setRemoteHead("develop", "sha-dev-1");
    git.setRemoteHead("staging", "sha-stg-2");
    git.mergeBase = async () => "sha-dev-1"; // base is an ancestor of staging
    const r = await ensureStaging({ gitClient: git });
    expect(r.created).toBe(false);
    expect(r.stagingTip).toBe("sha-stg-2");
  });

  it("fails loud on divergence (no silent reconcile)", async () => {
    const git = new FakeGitClient();
    git.setRemoteHead("develop", "sha-dev-1");
    git.setRemoteHead("staging", "sha-stg-1");
    git.mergeBase = async () => "sha-ancestor-0"; // neither is ancestor of the other
    await expect(ensureStaging({ gitClient: git })).rejects.toThrow(/DIVERGED/);
  });
});
