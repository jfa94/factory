/**
 * WS9 — holdout read-confinement tests (Δ Y). Executor Read/Grep/Bash cat of the
 * holdout store (absolute + traversal) is denied; non-holdout reads pass.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideHoldoutGuard } from "./holdout-guard.js";
import { parseHookInput, isDeny } from "./hook-io.js";

describe("holdout-guard — read confinement (Δ Y)", () => {
  let dataDir: string;
  let repoRoot: string;
  let holdoutFile: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "hg-data-"));
    repoRoot = mkdtempSync(join(tmpdir(), "hg-repo-"));
    const holdouts = join(dataDir, "runs", "run-1", "holdouts");
    mkdirSync(holdouts, { recursive: true });
    holdoutFile = join(holdouts, "answers.json");
    writeFileSync(holdoutFile, '{"answer":42}');
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const deps = () => ({ dataDir, cwd: repoRoot });

  function readInput(tool: string, fields: Record<string, string>) {
    return parseHookInput(JSON.stringify({ tool_name: tool, tool_input: fields }));
  }
  function bashInput(command: string) {
    return parseHookInput(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
  }

  it("Δ Y: Read of an absolute holdout path is denied", () => {
    expect(isDeny(decideHoldoutGuard(readInput("Read", { file_path: holdoutFile }), deps()))).toBe(
      true,
    );
  });

  it("Δ Y: Grep with a holdout path is denied", () => {
    const holdouts = join(dataDir, "runs", "run-1", "holdouts");
    expect(isDeny(decideHoldoutGuard(readInput("Grep", { path: holdouts }), deps()))).toBe(true);
  });

  it("Δ Y: Bash `cat` of the absolute holdout path is denied", () => {
    expect(isDeny(decideHoldoutGuard(bashInput(`cat ${holdoutFile}`), deps()))).toBe(true);
  });

  it("Δ Y: Bash `grep` of the holdout store is denied", () => {
    const holdouts = join(dataDir, "runs", "run-1", "holdouts");
    expect(
      isDeny(decideHoldoutGuard(bashInput(`grep secret ${holdouts}/answers.json`), deps())),
    ).toBe(true);
  });

  it("§4: a `..` traversal cat of the holdout store is denied", () => {
    const traversal = join(dataDir, "runs", "run-1", "holdouts", "..", "holdouts", "answers.json");
    expect(isDeny(decideHoldoutGuard(bashInput(`cat ${traversal}`), deps()))).toBe(true);
  });

  it("non-holdout run artifact read passes (per policy)", () => {
    const other = join(dataDir, "runs", "run-1", "state.json");
    writeFileSync(other, "{}");
    expect(isDeny(decideHoldoutGuard(readInput("Read", { file_path: other }), deps()))).toBe(false);
  });

  it("an in-repo read (no holdouts path) passes", () => {
    const src = join(repoRoot, "src.ts");
    writeFileSync(src, "x");
    expect(isDeny(decideHoldoutGuard(readInput("Read", { file_path: src }), deps()))).toBe(false);
  });

  it("a non-read Bash command (echo) passes", () => {
    expect(isDeny(decideHoldoutGuard(bashInput("echo hi"), deps()))).toBe(false);
  });
});
