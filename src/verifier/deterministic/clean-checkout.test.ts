/**
 * WS6 — gate-of-record clean-checkout lifecycle (Δ Z).
 *
 * The authority of record is a LOCAL re-run in a CLEAN worktree (not CI). Asserts:
 *  - createTaskWorktree → runner.run → removeWorktree lifecycle via the WS3
 *    FakeGitClient (no real git);
 *  - the worktree is torn down EVEN WHEN the runner THROWS (finally), so the
 *    trusted worktree never leaks;
 *  - the verdict returned is the runner's DERIVED verdict (the gate-of-record).
 */
import { describe, expect, it } from "vitest";
import { FakeGitClient } from "../../git/index.js";
import { defaultConfig } from "../../config/schema.js";
import { runGatesInCleanCheckout } from "./clean-checkout.js";
import { GateRunner, type GateContext } from "./gate-runner.js";
import { FakeGitProbe, FakeVitest, makeFakeTools, proc } from "./fakes.js";

/**
 * FakeGitClient seeded so createTaskWorktree's staging-tip assertion passes AND the
 * candidate ref resolves (the gate-of-record checks it out + asserts HEAD).
 */
function gitClient(): FakeGitClient {
  return new FakeGitClient({
    remoteHeads: { staging: "sha-staging-1" },
    localBranches: { candidate: { sha: "sha-candidate-1" } },
  });
}

function buildContext(tools: ReturnType<typeof makeFakeTools>) {
  return (created: { worktreePath: string; branch: string }): GateContext => ({
    runId: "r1",
    taskId: "t1",
    worktree: created.worktreePath,
    baseRef: "staging",
    config: defaultConfig(),
    tools,
    gates: ["test"],
    exemptReader: { isExempt: async () => false },
  });
}

const probe = new FakeGitProbe({ refs: { "origin/staging": "b", HEAD: "h" }, changedFiles: [] });

describe("runGatesInCleanCheckout (gate-of-record, Δ Z)", () => {
  it("creates the worktree, runs gates there, returns the DERIVED verdict, tears down", async () => {
    const git = gitClient();
    const tools = makeFakeTools({ git: probe, vitest: new FakeVitest(proc(0)) });
    const res = await runGatesInCleanCheckout({
      gitClient: git,
      runner: new GateRunner(),
      runId: "r1",
      taskId: "t1",
      worktreePath: "/tmp/clean-wt",
      candidateRef: "candidate",
      buildContext: buildContext(tools),
    });

    expect(res.verdict.__derived).toBe(true);
    expect(res.verdict.passed).toBe(true);
    // lifecycle: worktree added then removed (no leak).
    expect(git.calls.some((c) => c.startsWith("worktree add"))).toBe(true);
    expect(git.calls.some((c) => c.startsWith("worktree remove"))).toBe(true);
    expect(git.worktrees.has("/tmp/clean-wt")).toBe(false);
  });

  it("tears the worktree down EVEN WHEN the runner THROWS (finally)", async () => {
    const git = gitClient();
    // Truncated vitest output makes the test strategy throw inside the runner.
    const tools = makeFakeTools({ git: probe, vitest: new FakeVitest(proc(0, "", "", true)) });
    await expect(
      runGatesInCleanCheckout({
        gitClient: git,
        runner: new GateRunner(),
        runId: "r1",
        taskId: "t1",
        worktreePath: "/tmp/clean-wt-throw",
        candidateRef: "candidate",
        buildContext: buildContext(tools),
      }),
    ).rejects.toThrow(/truncated/i);

    // The throw must NOT leak the worktree.
    expect(git.calls.some((c) => c.startsWith("worktree remove"))).toBe(true);
    expect(git.worktrees.has("/tmp/clean-wt-throw")).toBe(false);
  });

  it("checks out the candidate before running the gates (validates task output, not pristine base)", async () => {
    const git = gitClient();
    const tools = makeFakeTools({ git: probe, vitest: new FakeVitest(proc(0)) });
    await runGatesInCleanCheckout({
      gitClient: git,
      runner: new GateRunner(),
      runId: "r1",
      taskId: "t1",
      worktreePath: "/tmp/clean-wt-candidate",
      candidateRef: "candidate",
      buildContext: buildContext(tools),
    });
    // The candidate is re-pointed into the clean worktree before gates run.
    expect(git.calls.some((c) => c.startsWith("checkout -B") && c.includes("candidate"))).toBe(
      true,
    );
  });

  it("fails LOUD when the checked-out HEAD != expectedSha (candidate moved since review)", async () => {
    const git = gitClient();
    const tools = makeFakeTools({ git: probe, vitest: new FakeVitest(proc(0)) });
    await expect(
      runGatesInCleanCheckout({
        gitClient: git,
        runner: new GateRunner(),
        runId: "r1",
        taskId: "t1",
        worktreePath: "/tmp/clean-wt-mismatch",
        candidateRef: "candidate",
        expectedSha: "sha-some-other-commit",
        buildContext: buildContext(tools),
      }),
    ).rejects.toThrow(/expected candidate sha/i);

    // Even on the mismatch throw, the worktree is torn down (no leak).
    expect(git.calls.some((c) => c.startsWith("worktree remove"))).toBe(true);
    expect(git.worktrees.has("/tmp/clean-wt-mismatch")).toBe(false);
  });
});
