import { describe, expect, it, vi } from "vitest";
import { DefaultGitClient } from "./git-client.js";
import type { ExecResult } from "../shared/index.js";
import type { GitRunner } from "./exec-tools.js";

function result(over: Partial<ExecResult>): ExecResult {
  return { stdout: "", stderr: "", code: 0, signal: null, truncated: false, ...over };
}

describe("DefaultGitClient over an injectable runner (no real git)", () => {
  it("branchExists treats a code-1 show-ref miss as a normal NO (not an error)", async () => {
    const runner: GitRunner = async (args) => {
      expect(args[0]).toBe("show-ref");
      return result({ code: 1 });
    };
    const git = new DefaultGitClient(runner);
    await expect(git.branchExists("nope")).resolves.toBe(false);
  });

  it("branchExists returns true on code 0 and throws on code > 1", async () => {
    const yes = new DefaultGitClient(async () => result({ code: 0 }));
    await expect(yes.branchExists("here")).resolves.toBe(true);
    const bad = new DefaultGitClient(async () => result({ code: 128, stderr: "fatal" }));
    await expect(bad.branchExists("x")).rejects.toThrow(/show-ref/);
  });

  it("fetch/checkoutB/push are fatal on non-zero (execOrThrow)", async () => {
    const runner: GitRunner = async () => result({ code: 1, stderr: "boom" });
    const git = new DefaultGitClient(runner);
    await expect(git.fetch("origin", "staging")).rejects.toThrow(/command failed/);
    await expect(git.checkoutB("b", "origin/staging")).rejects.toThrow(/command failed/);
    await expect(git.push("origin", "b")).rejects.toThrow(/command failed/);
  });

  it("push never passes a force flag (no force-push by construction)", async () => {
    const runner = vi.fn<GitRunner>(async () => result({ code: 0 }));
    const git = new DefaultGitClient(runner);
    await git.push("origin", "b", { setUpstream: true });
    const args = runner.mock.calls[0]![0];
    expect(args).toEqual(["push", "-u", "origin", "b"]);
    expect(args.some((a) => /force/i.test(a))).toBe(false);
  });

  it("lsRemoteHeads returns the sha or null on an empty result", async () => {
    const present = new DefaultGitClient(async () =>
      result({ stdout: "deadbeef\trefs/heads/staging\n" }),
    );
    await expect(present.lsRemoteHeads("origin", "staging")).resolves.toBe("deadbeef");
    const absent = new DefaultGitClient(async () => result({ stdout: "" }));
    await expect(absent.lsRemoteHeads("origin", "nope")).resolves.toBeNull();
  });

  it("the public GitClient surface exposes no force-push method", () => {
    const git = new DefaultGitClient(async () => result({ code: 0 }));
    expect((git as unknown as Record<string, unknown>).forcePush).toBeUndefined();
    expect((git as unknown as Record<string, unknown>).pushForce).toBeUndefined();
  });

  it("remoteUrl returns the trimmed url on success and null on a probe miss", async () => {
    const present = new DefaultGitClient(async (args) => {
      expect(args).toEqual(["remote", "get-url", "origin"]);
      return result({ stdout: "git@github.com:acme/widgets.git\n" });
    });
    await expect(present.remoteUrl("origin")).resolves.toBe("git@github.com:acme/widgets.git");
    // A non-zero exit (no such remote / not a git repo) is a normal NO, not a throw.
    const absent = new DefaultGitClient(async () => result({ code: 1, stderr: "no such remote" }));
    await expect(absent.remoteUrl("origin")).resolves.toBeNull();
  });

  it("mergeFfOrCommit checks out the branch then issues merge --no-edit <ref> (no force flag)", async () => {
    const calls: Array<readonly string[]> = [];
    const runner = vi.fn<GitRunner>(async (args) => {
      calls.push(args);
      return result({ code: 0 });
    });
    const git = new DefaultGitClient(runner);
    await git.mergeFfOrCommit("staging/run-1", "origin/develop");

    // First call: checkout branch
    expect(calls[0]).toEqual(["checkout", "staging/run-1"]);
    // Second call: merge --no-edit <ref> — no force flag anywhere
    expect(calls[1]).toEqual(["merge", "--no-edit", "origin/develop"]);
    expect(calls[1]!.some((a) => /force/i.test(a) || a === "-f")).toBe(false);
  });

  it("mergeFfOrCommit is fatal on non-zero (merge conflict propagates)", async () => {
    const runner: GitRunner = async (args) => {
      // checkout succeeds; merge fails (simulates a conflict)
      if (args[0] === "merge") return result({ code: 1, stderr: "CONFLICT" });
      return result({ code: 0 });
    };
    const git = new DefaultGitClient(runner);
    await expect(git.mergeFfOrCommit("staging/run-1", "origin/develop")).rejects.toThrow(
      /command failed/,
    );
  });
});
