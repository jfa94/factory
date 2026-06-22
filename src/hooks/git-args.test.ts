/**
 * Unit tests for the git-invocation tokenizer's `envNames` capture (Theme A) — the
 * field secret-guard reads to deny the index/repo-redirection env family. The rest
 * of parseGitInvocation is exercised through branch-protection's tests.
 */
import { describe, it, expect } from "vitest";
import { parseGitInvocation } from "./git-args.js";

describe("parseGitInvocation — envNames", () => {
  it("is empty when no env-var prefixes are present", () => {
    expect(parseGitInvocation("git commit -m x").envNames).toEqual([]);
  });

  it("records a single stripped env-var name (and still parses the subcommand)", () => {
    const inv = parseGitInvocation("GIT_INDEX_FILE=/tmp/evil.idx git commit -m x");
    expect(inv.envNames).toEqual(["GIT_INDEX_FILE"]);
    expect(inv.subcommand).toBe("commit");
  });

  it("records multiple env-var names in order", () => {
    const inv = parseGitInvocation("GIT_DIR=/d GIT_WORK_TREE=/w git push origin main");
    expect(inv.envNames).toEqual(["GIT_DIR", "GIT_WORK_TREE"]);
    expect(inv.subcommand).toBe("push");
  });

  it("captures the NAME only — the value (even one containing '=') is dropped", () => {
    const inv = parseGitInvocation("GIT_SSH_COMMAND=ssh-k=v git push");
    expect(inv.envNames).toEqual(["GIT_SSH_COMMAND"]);
  });

  it("does not treat a `-C` dir or a refspec as an env prefix", () => {
    const inv = parseGitInvocation("git -C /repo push origin develop:main");
    expect(inv.envNames).toEqual([]);
    expect(inv.workDir).toBe("/repo");
    expect(inv.destBranch).toBe("main");
  });
});
