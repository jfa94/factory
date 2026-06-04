/**
 * WS9 — secret-guard tests (Δ B). A staged secret blocks; git-dir override and
 * non-git target fail CLOSED; clean diff passes; nested-shell denied. The exec
 * seam is faked to return canned diffs (no real git).
 */
import { describe, it, expect } from "vitest";
import { decideSecretGuard, type ExecFn } from "./secret-guard.js";
import { parseHookInput, isDeny } from "./hook-io.js";
import type { ExecResult } from "../shared/exec.js";

function ok(stdout = ""): ExecResult {
  return { stdout, stderr: "", code: 0, signal: null, truncated: false };
}
function fail(): ExecResult {
  return { stdout: "", stderr: "boom", code: 128, signal: null, truncated: false };
}

function bashInput(command: string) {
  return parseHookInput(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
}

/** Build a fake exec that answers rev-parse OK and returns a canned diff. */
function fakeExec(diff: string, names = "src/x.ts", repoIsGit = true): ExecFn {
  return async (_cmd, args = []) => {
    const a = args.join(" ");
    if (a.includes("rev-parse --git-dir")) return repoIsGit ? ok(".git") : fail();
    if (a.includes("--name-only")) return ok(names);
    if (a.includes("diff") || a.includes("log")) return ok(diff);
    return ok();
  };
}

describe("secret-guard — provider secrets block (Δ B)", () => {
  const secretLines: Array<[string, string]> = [
    ["aws-access-key-id", "+const k = 'AKIAIOSFODNN7EXAMPLE'"],
    ["github classic pat", "+token=ghp_" + "a".repeat(36)],
    ["openai-style key", "+OPENAI='sk-" + "B".repeat(24) + "'"],
    ["anthropic key", "+ANTHROPIC=sk-ant-api03-" + "c".repeat(30)],
    ["stripe live secret", "+STRIPE=sk_live_" + "d".repeat(24)],
    ["google api key", "+G=AIza" + "e".repeat(35)],
  ];

  for (const [label, line] of secretLines) {
    it(`blocks commit with a ${label}`, async () => {
      const d = await decideSecretGuard(bashInput("git commit -m wip"), {
        exec: fakeExec(line),
        cwd: "/repo",
      });
      expect(isDeny(d)).toBe(true);
    });
  }

  it("blocks push whose unpushed diff has a secret", async () => {
    const d = await decideSecretGuard(bashInput("git push origin feature"), {
      exec: fakeExec("+key=ghs_" + "x".repeat(36)),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(true);
  });

  it("blocks a blocklisted path even with no content secret", async () => {
    const d = await decideSecretGuard(bashInput("git commit -m env"), {
      exec: fakeExec("+SOME=value", ".env"),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(true);
  });
});

describe("secret-guard — fail-closed (Δ B)", () => {
  it("git-dir override → fail-closed deny", async () => {
    const d = await decideSecretGuard(bashInput("git --git-dir=/other/.git commit -m x"), {
      exec: fakeExec("+clean"),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(true);
  });

  it("--work-tree override → fail-closed deny", async () => {
    const d = await decideSecretGuard(bashInput("git --work-tree=/other commit -m x"), {
      exec: fakeExec("+clean"),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(true);
  });

  it("GIT_DIR= env override → fail-closed deny", async () => {
    const d = await decideSecretGuard(bashInput("GIT_DIR=/other/.git git commit -m x"), {
      exec: fakeExec("+clean"),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(true);
  });

  it("non-git target → fail-closed deny", async () => {
    const d = await decideSecretGuard(bashInput("git commit -m x"), {
      exec: fakeExec("+clean", "src/x.ts", /*repoIsGit*/ false),
      cwd: "/not-a-repo",
    });
    expect(isDeny(d)).toBe(true);
  });

  it("git diff failure → fail-closed deny (empty diff != nothing staged)", async () => {
    const exec: ExecFn = async (_c, args = []) => {
      const a = args.join(" ");
      if (a.includes("rev-parse --git-dir")) return ok(".git");
      return fail();
    };
    const d = await decideSecretGuard(bashInput("git commit -m x"), { exec, cwd: "/repo" });
    expect(isDeny(d)).toBe(true);
  });
});

describe("secret-guard — clean & non-target pass", () => {
  it("clean staged diff passes", async () => {
    const d = await decideSecretGuard(bashInput("git commit -m clean"), {
      exec: fakeExec("+const x = 1"),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(false);
  });

  it("a non-commit/push git command passes (git status)", async () => {
    const d = await decideSecretGuard(bashInput("git status"), {
      exec: fakeExec("+secret ghp_" + "a".repeat(36)),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(false);
  });

  it("a non-git command passes", async () => {
    const d = await decideSecretGuard(bashInput("ls -la"), { exec: fakeExec(""), cwd: "/repo" });
    expect(isDeny(d)).toBe(false);
  });
});

describe("secret-guard — nested shell denied (autonomous)", () => {
  it("denies a nested shell wrapping a commit", async () => {
    const d = await decideSecretGuard(bashInput("bash -c 'git commit -m x'"), {
      exec: fakeExec("+clean"),
      cwd: "/repo",
      autonomousMode: true,
    });
    expect(isDeny(d)).toBe(true);
  });
});
