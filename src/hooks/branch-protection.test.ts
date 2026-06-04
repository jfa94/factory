/**
 * WS9 — branch-protection adversarial tests (implemented body). Ports the bash
 * parse vectors; the exec seam (current-branch) is faked. Each destructive form
 * must block; the staging-in-orchestrator-worktree exception allows.
 */
import { describe, it, expect } from "vitest";
import { decideBranchProtection, type BranchProtectionDeps } from "./branch-protection.js";
import { parseHookInput, isDeny } from "./hook-io.js";

function bashInput(command: string) {
  return parseHookInput(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
}

/** deps with a faked current-branch resolver. */
function deps(
  currentBranch: string,
  extra: Partial<BranchProtectionDeps> = {},
): BranchProtectionDeps {
  return {
    resolveCurrentBranch: async () => currentBranch,
    cwd: "/work/repo",
    autonomousMode: false,
    ...extra,
  };
}

describe("branch-protection — destructive forms block", () => {
  const cases: Array<[string, string, string]> = [
    ["plain push to protected", "git push origin main", "feature"],
    ["push HEAD:protected", "git push origin HEAD:refs/heads/main", "feature"],
    ["develop:main refspec", "git push origin develop:main", "feature"],
    ["--force to protected", "git push --force origin main", "feature"],
    ["-f to protected", "git push -f origin develop", "feature"],
    ["--force-with-lease to protected", "git push --force-with-lease origin main", "feature"],
    ["--force-if-includes to protected", "git push --force-if-includes origin main", "feature"],
    ["+refspec force to protected", "git push origin +HEAD:main", "feature"],
    ["push --delete protected", "git push origin --delete main", "feature"],
    ["branch -D protected", "git branch -D develop", "feature"],
    ["branch --delete protected", "git branch --delete main", "feature"],
    ["abs-path git push protected", "/usr/bin/git push origin main", "feature"],
    ["env-prefix git push protected", "GIT_PAGER=cat git push origin main", "feature"],
    ["-C dir push protected", "git -C /other push origin main", "feature"],
    ["quoted ref push protected", 'git push origin "main"', "feature"],
  ];

  for (const [label, command, current] of cases) {
    it(`blocks: ${label}`, async () => {
      const d = await decideBranchProtection(bashInput(command), deps(current));
      expect(isDeny(d)).toBe(true);
    });
  }

  it("blocks implicit push while ON a protected branch", async () => {
    const d = await decideBranchProtection(bashInput("git push"), deps("main"));
    expect(isDeny(d)).toBe(true);
  });

  it("blocks reset --hard while ON a protected branch (Check 6 gates on current)", async () => {
    const d = await decideBranchProtection(bashInput("git reset --hard HEAD~1"), deps("develop"));
    expect(isDeny(d)).toBe(true);
  });

  it("blocks --git-dir current-branch resolution for reset --hard", async () => {
    // The resolver is faked, but the parse must carry the subcommand+--hard.
    const d = await decideBranchProtection(
      bashInput("git --git-dir=/protected/.git reset --hard"),
      deps("main"),
    );
    expect(isDeny(d)).toBe(true);
  });
});

describe("branch-protection — allowed forms pass", () => {
  it("push to a non-protected branch passes", async () => {
    const d = await decideBranchProtection(
      bashInput("git push origin feature/x"),
      deps("feature/x"),
    );
    expect(isDeny(d)).toBe(false);
  });

  it("reset --hard on a disposable branch passes", async () => {
    const d = await decideBranchProtection(bashInput("git reset --hard HEAD~1"), deps("feature/x"));
    expect(isDeny(d)).toBe(false);
  });

  it("soft reset on protected is NOT blocked (--hard only)", async () => {
    const d = await decideBranchProtection(bashInput("git reset --soft HEAD~1"), deps("main"));
    expect(isDeny(d)).toBe(false);
  });

  it("non-git command passes", async () => {
    const d = await decideBranchProtection(bashInput("ls -la"), deps("main"));
    expect(isDeny(d)).toBe(false);
  });

  it("staging exception: push to staging ALLOWED inside an orchestrator worktree", async () => {
    const d = await decideBranchProtection(
      bashInput("git push origin staging"),
      deps("staging", {
        autonomousMode: true,
        cwd: "/work/.claude/worktrees/orchestrator-abc",
      }),
    );
    expect(isDeny(d)).toBe(false);
  });

  it("staging exception does NOT apply outside an orchestrator worktree", async () => {
    const d = await decideBranchProtection(
      bashInput("git push origin staging"),
      deps("staging", { autonomousMode: true, cwd: "/work/repo" }),
    );
    expect(isDeny(d)).toBe(true);
  });
});

describe("branch-protection — nested-shell denial (autonomous)", () => {
  it("denies a nested shell in autonomous mode", async () => {
    const d = await decideBranchProtection(
      bashInput("bash -c 'git push origin feature'"),
      deps("feature", { autonomousMode: true }),
    );
    expect(isDeny(d)).toBe(true);
  });
});
