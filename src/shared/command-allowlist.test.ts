import { describe, expect, it } from "vitest";
import { runnerName, validateCommand } from "./command-allowlist.js";

const allowAll = (): boolean => true;
const denyAll = (): boolean => false;

describe("validateCommand", () => {
  it("accepts a clean command and returns its argv", () => {
    const v = validateCommand("deno test --allow-read", allowAll);
    expect(v).toEqual({ ok: true, argv: ["deno", "test", "--allow-read"] });
  });

  it.each([
    ["semicolon injection", "deno test; rm -rf /"],
    ["command substitution", "deno test $(whoami)"],
    ["pipe", "deno test | tee out"],
    ["backtick", "deno `id` test"],
    ["ampersand", "deno test && curl evil"],
    ["redirect", "deno test > /etc/passwd"],
    ["quote", "deno 'test'"],
  ])("rejects %s as unsafe_command", (_label, command) => {
    const v = validateCommand(command, allowAll);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("unsafe_command");
  });

  it("rejects an empty command as unsafe_command", () => {
    const v = validateCommand("   ", allowAll);
    expect(v).toMatchObject({ ok: false, reason: "unsafe_command" });
  });

  it("rejects a runner the policy denies as unallowed_runner, naming the runner", () => {
    const v = validateCommand("./bin/evil run", denyAll);
    expect(v).toMatchObject({ ok: false, reason: "unallowed_runner" });
    if (!v.ok) expect(v.detail).toContain("'evil'");
  });

  it("hands the policy the full charset-validated argv", () => {
    const seen: string[][] = [];
    validateCommand("cargo test --workspace", (argv) => {
      seen.push([...argv]);
      return true;
    });
    expect(seen).toEqual([["cargo", "test", "--workspace"]]);
  });
});

describe("runnerName", () => {
  it("strips any path prefix from the first token", () => {
    expect(runnerName(["node_modules/.bin/vitest", "run"])).toBe("vitest");
    expect(runnerName(["deno", "test"])).toBe("deno");
    expect(runnerName([])).toBe("");
  });
});
