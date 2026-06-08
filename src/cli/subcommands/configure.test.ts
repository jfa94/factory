/**
 * Unit tests for `factory configure`. Each test gets an isolated temp data dir via
 * $CLAUDE_PLUGIN_DATA so the config writer/reader round-trips on real disk without
 * touching the host's config.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureCommand } from "./configure.js";
import { EXIT } from "../exit-codes.js";

let dataDir: string;
let prevEnv: string | undefined;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "factory-configure-"));
  prevEnv = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    stdout.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
    stderr.push(String(c));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (prevEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
  else process.env.CLAUDE_PLUGIN_DATA = prevEnv;
  await rm(dataDir, { recursive: true, force: true });
});

const out = () => JSON.parse(stdout.join("")) as Record<string, any>;

describe("factory configure", () => {
  it("prints the resolved config (all defaults) when no overlay exists", async () => {
    const code = await configureCommand.run([]);
    expect(code).toBe(EXIT.OK);
    const cfg = out();
    expect(cfg).toHaveProperty("quality.holdoutPercent");
    expect(cfg).toHaveProperty("quota.hourlyThresholds");
    expect(existsSync(join(dataDir, "config.json"))).toBe(false); // read-only path wrote nothing
  });

  it("--set persists a SPARSE overlay (only the edited key) and echoes the resolved config", async () => {
    const code = await configureCommand.run(["--set", "quality.holdoutPercent=25"]);
    expect(code).toBe(EXIT.OK);
    expect(out().quality.holdoutPercent).toBe(25);

    // On-disk overlay is sparse: it contains ONLY the edited path, not all defaults.
    const overlay = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
    expect(overlay).toEqual({ quality: { holdoutPercent: 25 } });
  });

  it("coerces JSON scalar types (number/boolean) and falls back to string", async () => {
    await configureCommand.run(["--set", "git.stagingBranch=staging"]);
    const overlay = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
    expect(overlay.git.stagingBranch).toBe("staging"); // bare string
  });

  it("--get prints a single resolved value", async () => {
    await configureCommand.run(["--set", "maxConsecutiveFailures=7"]);
    stdout.length = 0;
    const code = await configureCommand.run(["--get", "maxConsecutiveFailures"]);
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(stdout.join(""))).toBe(7);
  });

  it("--unset reverts a key to its default and prunes the empty parent", async () => {
    await configureCommand.run(["--set", "quality.holdoutPercent=25"]);
    const defaultPct = (await import("../../config/index.js")).defaultConfig().quality
      .holdoutPercent;

    stdout.length = 0;
    const code = await configureCommand.run(["--unset", "quality.holdoutPercent"]);
    expect(code).toBe(EXIT.OK);
    expect(out().quality.holdoutPercent).toBe(defaultPct);
    // The now-empty `quality` overlay object is pruned.
    const overlay = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
    expect(overlay).toEqual({});
  });

  it("rejects an out-of-schema value LOUDLY without persisting it", async () => {
    // holdoutPercent must be 0..100; 999 is a schema violation → throw (not USAGE).
    await expect(configureCommand.run(["--set", "quality.holdoutPercent=999"])).rejects.toThrow();
    // Nothing persisted.
    expect(existsSync(join(dataDir, "config.json"))).toBe(false);
  });

  it("multiple --set tokens apply in one atomic write", async () => {
    const code = await configureCommand.run([
      "--set",
      "quality.holdoutPercent=30",
      "--set",
      "maxConsecutiveFailures=5",
    ]);
    expect(code).toBe(EXIT.OK);
    const overlay = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
    expect(overlay).toEqual({ quality: { holdoutPercent: 30 }, maxConsecutiveFailures: 5 });
  });

  it("--get combined with --set is a USAGE error", async () => {
    const code = await configureCommand.run(["--get", "quality", "--set", "x=1"]);
    expect(code).toBe(EXIT.USAGE);
    expect(stderr.join("")).toMatch(/cannot be combined/);
  });

  it("--help returns OK", async () => {
    expect(await configureCommand.run(["--help"])).toBe(EXIT.OK);
    expect(stdout.join("")).toMatch(/factory configure/);
  });
});
