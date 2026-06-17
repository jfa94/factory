/**
 * Tests for E2 — `factory autonomy ensure`: the full-autonomy port of the old
 * `pipeline-ensure-autonomy`. It materializes `${CLAUDE_PLUGIN_DATA}/merged-settings.json`
 * from `templates/settings.autonomous.json` merged with the user's settings,
 * with placeholder substitution + env-baking + statusLine wiring, and prints the
 * `claude --settings <path>` relaunch command.
 *
 * The materialize core is pure + injectable (template string, user settings,
 * dataDir, pluginRoot) so units never touch the real ~/.claude or a real plugin
 * install.
 */
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { materializeMergedSettings, mergedSettingsPath, runAutonomyEnsure } from "./autonomy.js";

const PLUGIN_ROOT = "/opt/plugins/factory";
const DATA_DIR = "/home/u/.claude/plugins/data/factory-mkt";
const HOME = "/home/u";

/** A minimal but representative autonomous template (mirrors the real one's shape). */
const TEMPLATE = JSON.stringify({
  env: { FACTORY_AUTONOMOUS_MODE: "1" },
  permissions: { allow: ["Bash(*)", "Read(${CLAUDE_PLUGIN_DATA}/**)"], deny: ["Bash(rm -rf /)"] },
  statusLine: { type: "command", command: "${CLAUDE_PLUGIN_ROOT}/bin/factory statusline" },
  hooks: {
    PreToolUse: [
      {
        matcher: "Read",
        hooks: [
          {
            type: "command",
            command: "PD='${CLAUDE_PLUGIN_DATA}'; PDT='${CLAUDE_PLUGIN_DATA_TILDE}'; echo ok",
          },
        ],
      },
    ],
  },
});

describe("materializeMergedSettings", () => {
  it("substitutes ROOT, DATA and DATA_TILDE placeholders everywhere", () => {
    const out = materializeMergedSettings({
      template: TEMPLATE,
      userSettings: {},
      dataDir: DATA_DIR,
      pluginRoot: PLUGIN_ROOT,
      home: HOME,
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(json).not.toContain("${CLAUDE_PLUGIN_DATA}");
    expect(json).not.toContain("${CLAUDE_PLUGIN_DATA_TILDE}");
    // ROOT resolved in statusLine; DATA resolved in the allow-list entry.
    const sl = out.statusLine as { command: string };
    expect(sl.command).toBe(`${PLUGIN_ROOT}/bin/factory statusline`);
    const allow = (out.permissions as { allow: string[] }).allow;
    expect(allow).toContain(`Read(${DATA_DIR}/**)`);
    // DATA_TILDE resolves to the ~-shortened form of the data dir.
    const hookCmd = (out.hooks as { PreToolUse: { hooks: { command: string }[] }[] }).PreToolUse[0]!
      .hooks[0]!.command;
    expect(hookCmd).toContain(`PD='${DATA_DIR}'`);
    expect(hookCmd).toContain("PDT='~/.claude/plugins/data/factory-mkt'");
  });

  it("bakes CLAUDE_PLUGIN_DATA into the env block", () => {
    const out = materializeMergedSettings({
      template: TEMPLATE,
      userSettings: {},
      dataDir: DATA_DIR,
      pluginRoot: PLUGIN_ROOT,
      home: HOME,
    });
    const env = out.env as Record<string, string>;
    expect(env.CLAUDE_PLUGIN_DATA).toBe(DATA_DIR);
    expect(env.FACTORY_AUTONOMOUS_MODE).toBe("1"); // template env preserved
  });

  it("wires statusLine to factory statusline (NOT a copied wrapper script)", () => {
    const out = materializeMergedSettings({
      template: TEMPLATE,
      userSettings: {},
      dataDir: DATA_DIR,
      pluginRoot: PLUGIN_ROOT,
      home: HOME,
    });
    const sl = out.statusLine as { type: string; command: string };
    expect(sl.command).toBe(`${PLUGIN_ROOT}/bin/factory statusline`);
    // No data-dir wrapper copy: the command points at the bundle, not a .sh copy.
    expect(sl.command).not.toMatch(/statusline-wrapper\.sh/);
  });

  it("chains the user's existing statusLine via FACTORY_ORIGINAL_STATUSLINE", () => {
    const out = materializeMergedSettings({
      template: TEMPLATE,
      userSettings: { statusLine: { type: "command", command: "~/my/statusline.sh" } },
      dataDir: DATA_DIR,
      pluginRoot: PLUGIN_ROOT,
      home: HOME,
    });
    // Template statusLine wins (factory must capture rate_limits)...
    const sl = out.statusLine as { command: string };
    expect(sl.command).toBe(`${PLUGIN_ROOT}/bin/factory statusline`);
    // ...but the user's own is preserved as the chained original, ~ expanded.
    const env = out.env as Record<string, string>;
    expect(env.FACTORY_ORIGINAL_STATUSLINE).toBe(`${HOME}/my/statusline.sh`);
  });

  it("does NOT set FACTORY_ORIGINAL_STATUSLINE when the user already points at factory statusline", () => {
    const out = materializeMergedSettings({
      template: TEMPLATE,
      userSettings: { statusLine: { command: `${PLUGIN_ROOT}/bin/factory statusline` } },
      dataDir: DATA_DIR,
      pluginRoot: PLUGIN_ROOT,
      home: HOME,
    });
    const env = out.env as Record<string, string>;
    expect(env.FACTORY_ORIGINAL_STATUSLINE).toBeUndefined();
  });

  it("CHAINS a user statusLine that points at a NON-statusline factory subcommand", () => {
    // Tightened ownership check: only the `bin/factory statusline` WRITER is
    // treated as ours; any other factory subcommand the user wired is preserved.
    const out = materializeMergedSettings({
      template: TEMPLATE,
      userSettings: { statusLine: { command: `${PLUGIN_ROOT}/bin/factory some-other-cmd` } },
      dataDir: DATA_DIR,
      pluginRoot: PLUGIN_ROOT,
      home: HOME,
    });
    const env = out.env as Record<string, string>;
    expect(env.FACTORY_ORIGINAL_STATUSLINE).toBe(`${PLUGIN_ROOT}/bin/factory some-other-cmd`);
  });

  it("DROPS a stale FACTORY_ORIGINAL_STATUSLINE when the user statusLine is now ours", () => {
    // A prior autonomous relaunch baked FACTORY_ORIGINAL_STATUSLINE into the user's
    // env; now the user points at the factory writer, so there is nothing to chain —
    // the stale value must not survive (else the writer would chain to itself).
    const out = materializeMergedSettings({
      template: TEMPLATE,
      userSettings: {
        statusLine: { command: `${PLUGIN_ROOT}/bin/factory statusline` },
        env: { FACTORY_ORIGINAL_STATUSLINE: "/old/stale.sh" },
      },
      dataDir: DATA_DIR,
      pluginRoot: PLUGIN_ROOT,
      home: HOME,
    });
    const env = out.env as Record<string, string>;
    expect(env.FACTORY_ORIGINAL_STATUSLINE).toBeUndefined();
  });

  it("DROPS a stale FACTORY_ORIGINAL_STATUSLINE when the user has no statusLine at all", () => {
    const out = materializeMergedSettings({
      template: TEMPLATE,
      userSettings: { env: { FACTORY_ORIGINAL_STATUSLINE: "/old/stale.sh" } },
      dataDir: DATA_DIR,
      pluginRoot: PLUGIN_ROOT,
      home: HOME,
    });
    const env = out.env as Record<string, string>;
    expect(env.FACTORY_ORIGINAL_STATUSLINE).toBeUndefined();
  });

  it("uses the user settings as the base, overlaying template permissions/env/hooks", () => {
    const out = materializeMergedSettings({
      template: TEMPLATE,
      userSettings: {
        model: "opus",
        env: { MY_KEY: "v" },
        permissions: { allow: ["Bash(mine:*)"] },
      },
      dataDir: DATA_DIR,
      pluginRoot: PLUGIN_ROOT,
      home: HOME,
    });
    // User-only keys survive.
    expect(out.model).toBe("opus");
    // env is a union: user keys + template keys + baked DATA.
    const env = out.env as Record<string, string>;
    expect(env.MY_KEY).toBe("v");
    expect(env.FACTORY_AUTONOMOUS_MODE).toBe("1");
    expect(env.CLAUDE_PLUGIN_DATA).toBe(DATA_DIR);
    // permissions.allow unions user + template (template entries substituted).
    const allow = (out.permissions as { allow: string[] }).allow;
    expect(allow).toContain("Bash(mine:*)");
    expect(allow).toContain("Bash(*)");
    expect(allow).toContain(`Read(${DATA_DIR}/**)`);
  });

  it("throws LOUD when the template is not valid JSON", () => {
    expect(() =>
      materializeMergedSettings({
        template: "not json at all {{{",
        userSettings: {},
        dataDir: DATA_DIR,
        pluginRoot: PLUGIN_ROOT,
        home: HOME,
      }),
    ).toThrow(/JSON/);
  });

  it("throws LOUD when the template parses to a non-object (e.g. an array)", () => {
    expect(() =>
      materializeMergedSettings({
        template: JSON.stringify([1, 2, 3]),
        userSettings: {},
        dataDir: DATA_DIR,
        pluginRoot: PLUGIN_ROOT,
        home: HOME,
      }),
    ).toThrow(/not a JSON object/);
  });

  it("emits valid JSON (round-trips through stringify/parse)", () => {
    const out = materializeMergedSettings({
      template: TEMPLATE,
      userSettings: {},
      dataDir: DATA_DIR,
      pluginRoot: PLUGIN_ROOT,
      home: HOME,
    });
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });
});

describe("mergedSettingsPath", () => {
  it("is <dataDir>/merged-settings.json", () => {
    expect(mergedSettingsPath(DATA_DIR)).toBe(join(DATA_DIR, "merged-settings.json"));
  });
});

describe("runAutonomyEnsure", () => {
  let dataDir: string;
  let pluginRoot: string;
  const out: string[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-autonomy-data-"));
    pluginRoot = await mkdtemp(join(tmpdir(), "factory-autonomy-root-"));
    // Stage a minimal template under the fake plugin root.
    await mkdir(join(pluginRoot, "templates"), { recursive: true });
    await writeFile(join(pluginRoot, "templates", "settings.autonomous.json"), TEMPLATE, "utf8");
    out.length = 0;
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(pluginRoot, { recursive: true, force: true });
  });

  it("writes a valid merged-settings.json and prints the relaunch command", async () => {
    const result = await runAutonomyEnsure({
      dataDir,
      pluginRoot,
      userSettingsPath: join(pluginRoot, "no-such-user-settings.json"), // missing → {}
      home: HOME,
      writeStdout: (t) => out.push(t),
    });

    const path = join(dataDir, "merged-settings.json");
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    // Fully substituted + env baked + statusLine wired.
    expect(JSON.stringify(written)).not.toContain("${CLAUDE_PLUGIN");
    expect((written.env as Record<string, string>).CLAUDE_PLUGIN_DATA).toBe(dataDir);
    expect((written.statusLine as { command: string }).command).toBe(
      `${pluginRoot}/bin/factory statusline`,
    );
    expect(result.path).toBe(path);
    // Prints the relaunch command.
    const printed = out.join("");
    expect(printed).toContain(`claude --settings ${path}`);
  });

  it("reads the user's settings.json when present and chains its statusLine", async () => {
    const userSettingsPath = join(pluginRoot, "user-settings.json");
    await writeFile(
      userSettingsPath,
      JSON.stringify({ statusLine: { command: "~/mine.sh" }, model: "opus" }),
      "utf8",
    );
    await runAutonomyEnsure({
      dataDir,
      pluginRoot,
      userSettingsPath,
      home: HOME,
      writeStdout: (t) => out.push(t),
    });
    const written = JSON.parse(
      await readFile(join(dataDir, "merged-settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(written.model).toBe("opus");
    expect((written.env as Record<string, string>).FACTORY_ORIGINAL_STATUSLINE).toBe(
      `${HOME}/mine.sh`,
    );
  });

  it("degrades to an empty base (no throw) when the user's settings.json is unparseable", async () => {
    const userSettingsPath = join(pluginRoot, "user-settings.json");
    await writeFile(userSettingsPath, "{ this is : not json", "utf8");
    // Must NOT throw — a corrupt user settings file falls back to {} base.
    await runAutonomyEnsure({
      dataDir,
      pluginRoot,
      userSettingsPath,
      home: HOME,
      writeStdout: (t) => out.push(t),
    });
    const written = JSON.parse(
      await readFile(join(dataDir, "merged-settings.json"), "utf8"),
    ) as Record<string, unknown>;
    // Template defaults still applied; no user statusLine chained (base was empty).
    expect((written.env as Record<string, string>).CLAUDE_PLUGIN_DATA).toBe(dataDir);
    expect((written.env as Record<string, string>).FACTORY_ORIGINAL_STATUSLINE).toBeUndefined();
  });
});
