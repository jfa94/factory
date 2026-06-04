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

/** FakeGitClient seeded so createTaskWorktree's staging-tip assertion passes. */
function gitClient(): FakeGitClient {
  return new FakeGitClient({ remoteHeads: { staging: "sha-staging-1" } });
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
        buildContext: buildContext(tools),
      }),
    ).rejects.toThrow(/truncated/i);

    // The throw must NOT leak the worktree.
    expect(git.calls.some((c) => c.startsWith("worktree remove"))).toBe(true);
    expect(git.worktrees.has("/tmp/clean-wt-throw")).toBe(false);
  });
});
