/**
 * WS9 — write-protection adversarial tests (Δ B/W/Y). An executor Edit/Write/
 * MultiEdit against each TCB path is blocked; non-TCB passes; MultiEdit blocked
 * if ANY target is TCB.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideWriteProtection } from "./write-protection.js";
import { parseHookInput, isDeny } from "./hook-io.js";

describe("write-protection — TCB write-deny (Δ W)", () => {
  let repoRoot: string;
  let dataDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "wp-repo-"));
    dataDir = mkdtempSync(join(tmpdir(), "wp-data-"));
    mkdirSync(join(repoRoot, ".github", "workflows"), { recursive: true });
    mkdirSync(join(repoRoot, "hooks"), { recursive: true });
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    mkdirSync(join(dataDir, "runs", "run-1", "holdouts"), { recursive: true });
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  function editInput(tool: string, filePath: string, edits?: string[]) {
    const tool_input: Record<string, unknown> = { file_path: filePath };
    if (edits) tool_input.edits = edits.map((p) => ({ file_path: p }));
    return parseHookInput(JSON.stringify({ tool_name: tool, tool_input }));
  }

  const deps = () => ({ dataDir, repoRoot, cwd: repoRoot });

  it("Δ W: Edit to .github/workflows/quality-gate.yml is blocked", () => {
    const p = join(repoRoot, ".github", "workflows", "quality-gate.yml");
    writeFileSync(p, "x");
    expect(isDeny(decideWriteProtection(editInput("Edit", p), deps()))).toBe(true);
  });

  it("Δ W: Write to .stryker.config.json (gate config) is blocked", () => {
    const p = join(repoRoot, ".stryker.config.json");
    expect(isDeny(decideWriteProtection(editInput("Write", p), deps()))).toBe(true);
  });

  // jfa94/factory#11: an UNPROTECTED Stryker config sibling could be created and
  // loaded by Stryker ahead of the scaffolded .stryker.config.json; the .mjs/.js/
  // .cjs variants run arbitrary JS in the trusted gate process. All must be denied.
  it("Δ W: Write to executable Stryker config siblings is blocked (shadow + code-exec vectors)", () => {
    for (const name of [
      "stryker.config.mjs",
      "stryker.config.js",
      "stryker.config.cjs",
      "stryker.conf.js",
      ".stryker.config.mjs", // the dotted variant the outsidey repo actually had
    ]) {
      const p = join(repoRoot, name);
      expect(isDeny(decideWriteProtection(editInput("Write", p), deps()))).toBe(true);
    }
  });

  // jfa94/factory#11 (same gap class): dependency-cruiser's discovery loads
  // `.dependency-cruiser.{json,js,cjs,mjs}`; the executable variants run arbitrary
  // JS in the arch/lint gate process. The prior denylist protected only .cjs/.js
  // (and a never-loaded `dependency-cruiser.config.cjs`) — .json and .mjs were open.
  it("Δ W: Write to dependency-cruiser config siblings is blocked (shadow + code-exec vectors)", () => {
    for (const name of [
      ".dependency-cruiser.json",
      ".dependency-cruiser.js",
      ".dependency-cruiser.cjs",
      ".dependency-cruiser.mjs",
    ]) {
      const p = join(repoRoot, name);
      expect(isDeny(decideWriteProtection(editInput("Write", p), deps()))).toBe(true);
    }
  });

  it("Δ W: Edit to hooks/* is blocked", () => {
    const p = join(repoRoot, "hooks", "write-protection.sh");
    writeFileSync(p, "x");
    expect(isDeny(decideWriteProtection(editInput("Edit", p), deps()))).toBe(true);
  });

  it("Δ Y: Write into the holdout store is blocked", () => {
    const p = join(dataDir, "runs", "run-1", "holdouts", "answers.json");
    expect(isDeny(decideWriteProtection(editInput("Write", p), deps()))).toBe(true);
  });

  it("non-TCB src write passes", () => {
    const p = join(repoRoot, "src", "feature.ts");
    expect(isDeny(decideWriteProtection(editInput("Write", p), deps()))).toBe(false);
  });

  it("MultiEdit blocked if ANY target is TCB", () => {
    const ok = join(repoRoot, "src", "a.ts");
    const tcb = join(repoRoot, ".github", "workflows", "ci.yml");
    writeFileSync(tcb, "x");
    const input = editInput("MultiEdit", ok, [ok, tcb]);
    expect(isDeny(decideWriteProtection(input, deps()))).toBe(true);
  });

  it("§4: a `..` traversal write into a workflow is blocked", () => {
    const traversal = join(repoRoot, "src", "..", ".github", "workflows", "ci.yml");
    writeFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "x");
    expect(isDeny(decideWriteProtection(editInput("Edit", traversal), deps()))).toBe(true);
  });

  it("non-write tools (Read) pass through", () => {
    const p = join(repoRoot, ".github", "workflows", "ci.yml");
    writeFileSync(p, "x");
    const input = parseHookInput(
      JSON.stringify({ tool_name: "Read", tool_input: { file_path: p } }),
    );
    expect(isDeny(decideWriteProtection(input, deps()))).toBe(false);
  });
});
