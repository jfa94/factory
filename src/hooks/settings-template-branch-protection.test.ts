/**
 * Regression test for the `Edit|Write` branch-protection PreToolUse hook embedded
 * inline in templates/settings.autonomous.json (the "Cannot edit on main/master"
 * guard). Unlike branch-protection.ts (which guards destructive `git` Bash
 * invocations), this hook has no typed counterpart — it is a raw shell command
 * string, so it is exercised here by actually running it under bash with a
 * temp git repo, rather than through a TS unit.
 *
 * Bug: the hook used to call bare `git branch --show-current` (no `-C`, no
 * target-path resolution), so it read the *caller's* cwd repo/branch — not
 * the repo owning the file actually being written. That both (a) blocked
 * edits to files entirely outside any git repo (e.g. the plugin data dir) and
 * (b) checked the wrong repo's branch when the target file lived in a
 * different repo than the caller's cwd.
 */
import { execSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface HookEntry {
  matcher: string;
  hooks: { command: string }[];
}

function loadBranchProtectionCommand(): string {
  const templatePath = join(import.meta.dirname, "../../templates/settings.autonomous.json");
  const template = JSON.parse(readFileSync(templatePath, "utf8")) as {
    hooks: { PreToolUse: HookEntry[] };
  };
  const entry = template.hooks.PreToolUse.find(
    (e) => e.matcher === "Edit|Write" && e.hooks[0]?.command.includes("Cannot edit on main/master"),
  );
  if (!entry) throw new Error("branch-protection Edit|Write hook not found in template");
  return entry.hooks[0]!.command;
}

function runHook(
  command: string,
  filePath: string,
  cwd: string,
): { decision?: string; reason?: string } | null {
  const stdin = JSON.stringify({ tool_input: { file_path: filePath } });
  const result = spawnSync("bash", ["-c", command], { input: stdin, cwd, encoding: "utf8" });
  const out = result.stdout.trim();
  return out.length > 0 ? (JSON.parse(out) as { decision?: string; reason?: string }) : null;
}

describe("templates/settings.autonomous.json — Edit|Write branch-protection hook", () => {
  let callerRepo: string;
  let otherRepoOnMain: string;
  let otherRepoOnFeature: string;
  let outsideAnyRepo: string;

  beforeEach(async () => {
    callerRepo = await mkdtemp(join(tmpdir(), "caller-repo-"));
    execSync("git init -q -b main", { cwd: callerRepo });

    otherRepoOnMain = await mkdtemp(join(tmpdir(), "other-repo-main-"));
    execSync("git init -q -b main", { cwd: otherRepoOnMain });

    otherRepoOnFeature = await mkdtemp(join(tmpdir(), "other-repo-feature-"));
    execSync("git init -q -b main", { cwd: otherRepoOnFeature });
    execSync("git checkout -q -b feature/x", { cwd: otherRepoOnFeature });

    outsideAnyRepo = await mkdtemp(join(tmpdir(), "no-repo-"));
  });

  afterEach(async () => {
    await rm(callerRepo, { recursive: true, force: true });
    await rm(otherRepoOnMain, { recursive: true, force: true });
    await rm(otherRepoOnFeature, { recursive: true, force: true });
    await rm(outsideAnyRepo, { recursive: true, force: true });
  });

  it("allows a write to a file entirely outside any git repo, even from a main-branch caller cwd", () => {
    const command = loadBranchProtectionCommand();
    const target = join(outsideAnyRepo, "generated.json");
    const decision = runHook(command, target, callerRepo);
    expect(decision).toBeNull();
  });

  it("blocks a write to a file inside a DIFFERENT repo that is on main, even from a feature-branch caller cwd", () => {
    execSync("git checkout -q -b feature/caller", { cwd: callerRepo });
    const command = loadBranchProtectionCommand();
    const target = join(otherRepoOnMain, "src", "foo.ts");
    const decision = runHook(command, target, callerRepo);
    expect(decision?.decision).toBe("block");
  });

  it("allows a write to a file inside a DIFFERENT repo that is on a feature branch, even from a main-branch caller cwd", () => {
    const command = loadBranchProtectionCommand();
    const target = join(otherRepoOnFeature, "src", "foo.ts");
    const decision = runHook(command, target, callerRepo);
    expect(decision).toBeNull();
  });

  it("blocks a write to a file in the caller's own repo when that repo is on main", () => {
    const command = loadBranchProtectionCommand();
    const target = join(callerRepo, "src", "foo.ts");
    const decision = runHook(command, target, callerRepo);
    expect(decision?.decision).toBe("block");
  });
});
