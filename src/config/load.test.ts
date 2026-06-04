import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveDataDir, configPath } from "./load.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "factory-home-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("resolveDataDir", () => {
  it("honors an explicit dataDir override verbatim (resolved)", () => {
    expect(resolveDataDir({ dataDir: "/tmp/explicit" })).toBe("/tmp/explicit");
  });

  it("uses CLAUDE_PLUGIN_DATA when set and not a foreign-plugin leak", () => {
    const dd = join(home, ".claude", "plugins", "data", "factory-mymarket");
    const out = resolveDataDir({ env: { CLAUDE_PLUGIN_DATA: dd }, home });
    expect(out).toBe(dd);
  });

  it("throws loudly when CLAUDE_PLUGIN_DATA is unset and no override", () => {
    expect(() => resolveDataDir({ env: {}, home })).toThrow(/CLAUDE_PLUGIN_DATA must be set/);
  });

  it("leaves a non-data-root custom path untouched", () => {
    const custom = "/some/custom/path";
    expect(resolveDataDir({ env: { CLAUDE_PLUGIN_DATA: custom }, home })).toBe(custom);
  });

  it("canonicalizes a foreign-plugin leak via the cache layout", () => {
    // Simulate: pluginRoot is the cache <version> dir, current points at a
    // FOREIGN data dir under ~/.claude/plugins/data/.
    const pluginRoot = join(home, ".claude", "plugins", "cache", "jfa94", "factory", "0.10.5");
    mkdirSync(pluginRoot, { recursive: true });
    const foreign = join(home, ".claude", "plugins", "data", "codex-openai-codex");
    const out = resolveDataDir({
      env: { CLAUDE_PLUGIN_DATA: foreign },
      home,
      pluginRoot,
    });
    // Expected: <data>/<plugin>-<marketplace> = factory-jfa94
    expect(out).toBe(join(home, ".claude", "plugins", "data", "factory-jfa94"));
  });

  it("does NOT rewrite a path already under our own basename", () => {
    const pluginRoot = join(home, ".claude", "plugins", "cache", "jfa94", "factory", "0.10.5");
    mkdirSync(pluginRoot, { recursive: true });
    const ours = join(home, ".claude", "plugins", "data", "factory-jfa94");
    expect(resolveDataDir({ env: { CLAUDE_PLUGIN_DATA: ours }, home, pluginRoot })).toBe(ours);
  });
});

describe("loadConfig", () => {
  it("returns all defaults when config.json is absent", () => {
    const dd = join(home, "data");
    const cfg = loadConfig({ dataDir: dd });
    expect(cfg.quota.sleepCapSec).toBe(540);
  });

  it("merges a present config.json over defaults", () => {
    const dd = join(home, "data");
    mkdirSync(dd, { recursive: true });
    writeFileSync(configPath(dd), JSON.stringify({ quota: { sleepCapSec: 120 } }));
    const cfg = loadConfig({ dataDir: dd });
    expect(cfg.quota.sleepCapSec).toBe(120);
    expect(cfg.quality.holdoutPercent).toBe(20); // untouched default
  });

  it("throws LOUDLY on a corrupt config.json (no silent default)", () => {
    const dd = join(home, "data");
    mkdirSync(dd, { recursive: true });
    writeFileSync(configPath(dd), "{ this is not json");
    expect(() => loadConfig({ dataDir: dd })).toThrow();
  });

  it("throws on a schema-invalid config.json", () => {
    const dd = join(home, "data");
    mkdirSync(dd, { recursive: true });
    writeFileSync(configPath(dd), JSON.stringify({ quota: { sleepCapSec: -5 } }));
    expect(() => loadConfig({ dataDir: dd })).toThrow();
  });
});
