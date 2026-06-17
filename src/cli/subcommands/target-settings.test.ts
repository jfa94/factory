/**
 * Tests for the E1 (F-perm) target-repo `.claude/settings.json` emit + merge.
 *
 * `ensureTargetSettings` writes (or idempotently MERGES into) the TARGET repo's
 * `.claude/settings.json` so an interactive `/factory:run` stops prompting per
 * call. The invariants under test:
 *   - emit: a fresh repo gets the factory allow-list + worktree.baseRef:"head".
 *   - NO statusLine (would clobber the user's own statusline — E2 territory).
 *   - merge: an existing settings.json keeps the user's other keys; the
 *     allow-list is UNIONed (no duplicates); worktree.baseRef is set.
 *   - idempotent: re-running reports "present", makes no further change.
 */
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FACTORY_TARGET_ALLOWLIST,
  mergeTargetSettings,
  ensureTargetSettings,
} from "./target-settings.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "factory-target-settings-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const settingsPath = (): string => join(root, ".claude", "settings.json");

async function readSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsPath(), "utf8")) as Record<string, unknown>;
}

describe("FACTORY_TARGET_ALLOWLIST", () => {
  it("covers the factory CLI, git/gh, the agent tools, and the data dir", () => {
    // The pipeline shells `factory <subcommand>` and runs git/gh; reviewers and
    // producers use the agent tools and read/write the data dir.
    expect(FACTORY_TARGET_ALLOWLIST).toContain("Bash(factory:*)");
    expect(FACTORY_TARGET_ALLOWLIST).toContain("Bash(git:*)");
    expect(FACTORY_TARGET_ALLOWLIST).toContain("Bash(gh:*)");
    expect(FACTORY_TARGET_ALLOWLIST).toContain("Agent");
    expect(FACTORY_TARGET_ALLOWLIST).toContain("Read");
    expect(FACTORY_TARGET_ALLOWLIST).toContain("Write");
    expect(FACTORY_TARGET_ALLOWLIST).toContain("Edit");
    expect(FACTORY_TARGET_ALLOWLIST).toContain("Grep");
    expect(FACTORY_TARGET_ALLOWLIST).toContain("Glob");
    expect(FACTORY_TARGET_ALLOWLIST).toContain("Read(${CLAUDE_PLUGIN_DATA}/**)");
    expect(FACTORY_TARGET_ALLOWLIST).toContain("Write(${CLAUDE_PLUGIN_DATA}/**)");
    expect(FACTORY_TARGET_ALLOWLIST).toContain("Edit(${CLAUDE_PLUGIN_DATA}/**)");
  });

  it("does NOT carry a statusLine — that would override the user's own", () => {
    // Sanity: the allow-list is permissions only; no statusLine entry leaks in.
    for (const entry of FACTORY_TARGET_ALLOWLIST) {
      expect(entry.toLowerCase()).not.toContain("statusline");
    }
  });

  it("has no duplicate entries", () => {
    expect(new Set(FACTORY_TARGET_ALLOWLIST).size).toBe(FACTORY_TARGET_ALLOWLIST.length);
  });
});

describe("mergeTargetSettings", () => {
  it("from empty: sets worktree.baseRef:head + the full allow-list, no statusLine", () => {
    const { settings, changed } = mergeTargetSettings({});
    expect(changed).toBe(true);
    expect((settings.worktree as { baseRef?: string }).baseRef).toBe("head");
    const allow = (settings.permissions as { allow: string[] }).allow;
    for (const e of FACTORY_TARGET_ALLOWLIST) expect(allow).toContain(e);
    expect(settings).not.toHaveProperty("statusLine");
  });

  it("unions the allow-list without clobbering the user's other keys", () => {
    const existing = {
      env: { MY_VAR: "1" },
      permissions: { allow: ["Bash(docker:*)"], deny: ["Bash(rm -rf /)"] },
      worktree: { baseRef: "fresh", other: "keep-me" },
      statusLine: { type: "command", command: "my-own-statusline" },
    };
    const { settings } = mergeTargetSettings(existing);

    // User keys preserved.
    expect(settings.env).toEqual({ MY_VAR: "1" });
    const perms = settings.permissions as { allow: string[]; deny: string[] };
    expect(perms.allow).toContain("Bash(docker:*)"); // user's entry kept
    expect(perms.allow).toContain("Bash(factory:*)"); // factory entry added
    expect(perms.deny).toEqual(["Bash(rm -rf /)"]); // deny untouched
    // worktree.baseRef forced to head, sibling keys preserved.
    const wt = settings.worktree as { baseRef: string; other: string };
    expect(wt.baseRef).toBe("head");
    expect(wt.other).toBe("keep-me");
    // The user's OWN statusLine is never touched by E1.
    expect(settings.statusLine).toEqual({ type: "command", command: "my-own-statusline" });
  });

  it("is idempotent: merging an already-merged settings reports no change + no dupes", () => {
    const { settings: once } = mergeTargetSettings({});
    const { settings: twice, changed } = mergeTargetSettings(once);
    expect(changed).toBe(false);
    const allow = (twice.permissions as { allow: string[] }).allow;
    expect(new Set(allow).size).toBe(allow.length); // no duplicates on re-merge
  });

  it("reports changed when baseRef was not yet head even if allow-list is complete", () => {
    const base = mergeTargetSettings({}).settings;
    (base.worktree as { baseRef: string }).baseRef = "fresh";
    const { changed, settings } = mergeTargetSettings(base);
    expect(changed).toBe(true);
    expect((settings.worktree as { baseRef: string }).baseRef).toBe("head");
  });
});

describe("ensureTargetSettings", () => {
  it("creates .claude/settings.json on a fresh repo and reports it created", async () => {
    const result = await ensureTargetSettings({ targetRoot: root });
    expect(result.created).toBe(true);
    expect(existsSync(settingsPath())).toBe(true);
    const written = await readSettings();
    expect((written.worktree as { baseRef: string }).baseRef).toBe("head");
    expect((written.permissions as { allow: string[] }).allow).toContain("Bash(factory:*)");
    expect(written).not.toHaveProperty("statusLine");
  });

  it("merges non-destructively into an existing settings.json", async () => {
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(
      settingsPath(),
      JSON.stringify({ statusLine: { command: "mine" }, permissions: { allow: ["Bash(make:*)"] } }),
      "utf8",
    );
    const result = await ensureTargetSettings({ targetRoot: root });
    expect(result.created).toBe(false);
    expect(result.changed).toBe(true);
    const written = await readSettings();
    expect(written.statusLine).toEqual({ command: "mine" }); // untouched
    const allow = (written.permissions as { allow: string[] }).allow;
    expect(allow).toContain("Bash(make:*)");
    expect(allow).toContain("Bash(factory:*)");
  });

  it("is idempotent on disk: a second run reports no change", async () => {
    await ensureTargetSettings({ targetRoot: root });
    const second = await ensureTargetSettings({ targetRoot: root });
    expect(second.created).toBe(false);
    expect(second.changed).toBe(false);
  });

  it("WARNS (not silently coerces) when an existing settings.json is valid JSON but not an object", async () => {
    // A non-object settings.json (here a JSON array) is about to be REPLACED by the
    // merged object — that destructive overwrite must be surfaced, not swallowed.
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(settingsPath(), JSON.stringify(["not", "an", "object"]), "utf8");
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await ensureTargetSettings({ targetRoot: root });
      expect(result.created).toBe(false);
      // The factory settings object replaced the array.
      const written = await readSettings();
      expect((written.worktree as { baseRef: string }).baseRef).toBe("head");
      // The replacement warned, naming the path + that it's being replaced.
      const warned = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(warned).toMatch(/not an object/i);
      expect(warned).toContain("settings.json");
    } finally {
      spy.mockRestore();
    }
  });
});
