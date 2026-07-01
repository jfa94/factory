import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGhClient, FakeGitClient } from "./fakes.js";
import type { GhClient, GitClient } from "./index.js";
import { createTaskPrIdempotent } from "./pr.js";
import { MergeSerializer } from "./serial-writer.js";

describe("Fakes contract — structural conformance + zero-binary smoke", () => {
  it("FakeGitClient/FakeGhClient satisfy the GitClient/GhClient interfaces (compile-time)", () => {
    // Pure compile-time assignability check (the build/typecheck enforces it).
    const git: GitClient = new FakeGitClient();
    const gh: GhClient = new FakeGhClient();
    expect(git).toBeInstanceOf(FakeGitClient);
    expect(gh).toBeInstanceOf(FakeGhClient);
  });

  it("smoke: create → list → merge against the fakes with NO real binary", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ws3-smoke-"));
    try {
      const gh = new FakeGhClient();
      // create
      const created = await createTaskPrIdempotent({
        ghClient: gh,
        branch: "factory/run-1/t1",
        title: "t1",
        body: "b",
        base: "staging",
      });
      expect(created.resumed).toBe(false);

      // list (via idempotent re-call resumes the same PR)
      const resumed = await createTaskPrIdempotent({
        ghClient: gh,
        branch: "factory/run-1/t1",
        title: "t1",
        body: "b",
        base: "staging",
      });
      expect(resumed.number).toBe(created.number);

      // merge
      const ser = new MergeSerializer({
        ghClient: gh,
        owner: "fake",
        repo: "repo",
        dataDir,
        lock: { stale: 5_000, retries: 50, retryMinTimeout: 1, retryMaxTimeout: 10 },
      });
      const outcome = await ser.merge(created.number);
      expect(outcome.merged).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("FakeGhClient.listIssueComments (backs finalize's idempotency check)", () => {
  it("returns the bodies of previously-recorded comments matching repo + number", async () => {
    const gh = new FakeGhClient();
    await gh.issueComment({ repo: "acme/widgets", number: 42, body: "PRD delivered" });
    await gh.issueComment({ repo: "acme/widgets", number: 42, body: "run failed" });
    // a comment on a different issue/repo must not leak in
    await gh.issueComment({ repo: "acme/widgets", number: 7, body: "other issue" });
    await gh.issueComment({ repo: "other/repo", number: 42, body: "other repo" });

    const bodies = await gh.listIssueComments({ repo: "acme/widgets", number: 42 });
    expect(bodies).toEqual(["PRD delivered", "run failed"]);
  });

  it("returns an empty array when the issue has no comments yet", async () => {
    const gh = new FakeGhClient();
    expect(await gh.listIssueComments({ repo: "acme/widgets", number: 42 })).toEqual([]);
  });
});

describe("FakeGitClient behavior helpers", () => {
  let _tmp: string;
  beforeEach(async () => {
    _tmp = await mkdtemp(join(tmpdir(), "ws3-fakegit-"));
  });
  afterEach(async () => {
    await rm(_tmp, { recursive: true, force: true });
  });

  it("push records the call and advances the remote head; setUpstream flag captured", async () => {
    const git = new FakeGitClient({ localBranches: { "factory/run-1/t1": { sha: "sha-x" } } });
    await git.push("origin", "factory/run-1/t1", { setUpstream: true });
    expect(git.getRemoteHead("factory/run-1/t1")).toBe("sha-x");
    expect(git.calls).toContain("push -u origin factory/run-1/t1");
  });
});

describe("FakeGitClient.worktreeAdd — -b vs -B fidelity (crash-left-branch hazard)", () => {
  it("worktree add -b FATALS when <branch> already exists locally, even at a fresh path — mirrors real git", async () => {
    const git = new FakeGitClient({ remoteHeads: { staging: "sha-staging-1" } });
    await git.worktreeAdd(["-b", "e2e-run-1", "/tmp/wt-a", "origin/staging"]);
    await git.worktreeRemove(["/tmp/wt-a", "--force"]); // path gone, branch survives (the crash scenario)
    await expect(
      git.worktreeAdd(["-b", "e2e-run-1", "/tmp/wt-b", "origin/staging"]),
    ).rejects.toThrow(/already exists/);
  });

  it("worktree add -B force-creates/resets <branch> even when it already exists — the crash-safe mode", async () => {
    const git = new FakeGitClient({ remoteHeads: { staging: "sha-staging-1" } });
    await git.worktreeAdd(["-b", "e2e-run-1", "/tmp/wt-a", "origin/staging"]);
    await git.worktreeRemove(["/tmp/wt-a", "--force"]);
    await expect(
      git.worktreeAdd(["-B", "e2e-run-1", "/tmp/wt-b", "origin/staging"]),
    ).resolves.toBeUndefined();
    expect(git.worktrees.get("/tmp/wt-b")).toBe("e2e-run-1");
  });
});
