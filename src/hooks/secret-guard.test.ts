/**
 * WS9 — secret-guard tests (Δ B). A staged secret blocks; the redirection bypasses
 * (--git-dir/--work-tree flags + the index/repo-redirecting env family) and a
 * non-git target fail CLOSED; benign GIT_* and clean diffs pass; nested-shell
 * denied; the `-C` target is resolved last-wins. The exec seam is faked to return
 * canned diffs (no real git).
 */
import { describe, it, expect } from "vitest";
import { decideSecretGuard, type ExecFn } from "./secret-guard.js";
import { parseHookInput, isDeny } from "./hook-io.js";
import type { ExecResult } from "../shared/exec.js";
import { KNOWN_PUBLIC_TOKENS } from "../shared/secret-patterns.js";

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

describe("secret-guard — committable env files (ENV_COMMITTABLE)", () => {
  it("allows .env.example with benign content (path skip)", async () => {
    const d = await decideSecretGuard(bashInput("git commit -m ex"), {
      exec: fakeExec("+SUPABASE_URL=http://localhost:54321", ".env.example"),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(false);
  });

  it("allows .env.test with benign content (path skip)", async () => {
    const d = await decideSecretGuard(bashInput("git commit -m test"), {
      exec: fakeExec("+FOO=bar", ".env.test"),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(false);
  });

  it("allows .env.test containing published Supabase local-dev JWTs", async () => {
    const tok = KNOWN_PUBLIC_TOKENS[0]!;
    const d = await decideSecretGuard(bashInput("git commit -m t5"), {
      exec: fakeExec(`+ANON_KEY=${tok}`, ".env.test"),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(false);
  });

  it("still blocks .env.test containing a real provider key (content scan survives)", async () => {
    const d = await decideSecretGuard(bashInput("git commit -m t5"), {
      exec: fakeExec("+AWS_KEY=AKIA" + "IOSFODNN7EXAMPLE", ".env.test"),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(true);
  });

  // Regression: plain .env and env-with-environment-suffix remain path-blocked.
  it("still blocks plain .env", async () => {
    const d = await decideSecretGuard(bashInput("git commit -m env"), {
      exec: fakeExec("+FOO=bar", ".env"),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(true);
  });

  it("still blocks .env.local", async () => {
    const d = await decideSecretGuard(bashInput("git commit -m env"), {
      exec: fakeExec("+FOO=bar", ".env.local"),
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

describe("secret-guard — redirection bypasses (Theme A root fix)", () => {
  // The index/repo-redirecting env family — each decouples the committed
  // index/store from what `git diff --cached` scans, so each must deny fail-closed.
  const REDIRECT_VARS = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
  ];
  for (const v of REDIRECT_VARS) {
    it(`${v}= env override on commit → fail-closed deny`, async () => {
      const d = await decideSecretGuard(bashInput(`${v}=/tmp/x git commit -m x`), {
        exec: fakeExec("+clean"),
        cwd: "/repo",
      });
      expect(isDeny(d)).toBe(true);
    });
  }

  // Regression guard for the deny-all-GIT_* correction: this guard fires on EVERY
  // Bash (not only autonomous), so a human's benign GIT_* must pass.
  it("benign GIT_SSH_COMMAND= on push is ALLOWED (not a redirection bypass)", async () => {
    const d = await decideSecretGuard(
      bashInput("GIT_SSH_COMMAND=/usr/bin/ssh git push origin main"),
      { exec: fakeExec("+const x = 1"), cwd: "/repo" },
    );
    expect(isDeny(d)).toBe(false);
  });

  it("benign GIT_AUTHOR_NAME= on commit is ALLOWED", async () => {
    const d = await decideSecretGuard(bashInput("GIT_AUTHOR_NAME=alice git commit -m x"), {
      exec: fakeExec("+const x = 1"),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(false);
  });

  // Last-wins `-C`: git honors the LAST -C, so the guard must scan that repo. A
  // first-match scan read /clean and missed a secret staged in /secret.
  function dirAwareExec(): ExecFn {
    return async (_cmd, args = []) => {
      const a = args.join(" ");
      if (a.includes("rev-parse --git-dir")) return ok(".git");
      const scansSecret = a.includes("-C /secret");
      if (a.includes("--name-only")) return ok("src/x.ts");
      if (a.includes("diff") || a.includes("log")) {
        return ok(scansSecret ? "+key=ghp_" + "a".repeat(36) : "+const x = 1");
      }
      return ok();
    };
  }

  it("last-wins -C: scans the repo git will commit (git -C /clean -C /secret)", async () => {
    const d = await decideSecretGuard(bashInput("git -C /clean -C /secret commit -m x"), {
      exec: dirAwareExec(),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(true); // last -C is /secret → scanned it, caught the secret
  });

  it("last-wins -C: a secret in an EARLIER -C the commit won't use does not block", async () => {
    const d = await decideSecretGuard(bashInput("git -C /secret -C /clean commit -m x"), {
      exec: dirAwareExec(),
      cwd: "/repo",
    });
    expect(isDeny(d)).toBe(false); // last -C is /clean → that's what git commits & we scan
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
