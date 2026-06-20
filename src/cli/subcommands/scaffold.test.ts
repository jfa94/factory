/**
 * Unit tests for `factory scaffold`. Drives the injectable {@link runScaffold} core
 * with fake git/gh clients + a temp target repo + the REAL templates dir, so the
 * template copy, staging-ensure, and protection probe/refuse/provision are all
 * exercised without touching the host repo or the network.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  runScaffold,
  resolveTemplatesDir,
  scaffoldCommand,
  resolveScaffoldRepo,
} from "./scaffold.js";
import { parseArgs } from "../args.js";
import { EXIT } from "../exit-codes.js";
import { defaultConfig } from "../../config/index.js";
import { buildTargetDataDirRules } from "./target-settings.js";
import { FakeGitClient, FakeGhClient } from "../../git/index.js";
import type { ProtectionApiResult } from "../../git/index.js";

const cfg = defaultConfig();
const BASE = cfg.git.baseBranch; // "develop"

/** Baked data-dir permission rules injected into runScaffold (E1, F-perm). */
const DATA_DIR_RULES = buildTargetDataDirRules({
  dataDir: "/Users/jo/.claude/plugins/data/factory-jfa94",
  home: "/Users/jo",
});

/** Protection state that satisfies requireProtectionOrRefuse (no required checks). */
const PROTECTED: ProtectionApiResult = {
  enabled: true,
  requiredStatusChecks: [],
  strictUpToDate: true,
  hasMergeQueue: false,
};

let root: string;
let templatesDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "factory-scaffold-"));
  templatesDir = resolveTemplatesDir();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runScaffold", () => {
  it("copies the CI template + manages .gitignore, and reports protection on develop", async () => {
    const report = await runScaffold({
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      dataDirRules: DATA_DIR_RULES,
      ghClient: new FakeGhClient({ protection: { [BASE]: PROTECTED } }),
      provision: false,
    });

    expect(existsSync(join(root, ".github", "workflows", "quality-gate.yml"))).toBe(true);
    expect(existsSync(join(root, ".gitignore"))).toBe(true);
    expect(report.files_created).toContain(".github/workflows/quality-gate.yml");
    // The cost-aware shard helper is a plugin-MANAGED file shipped with the CI net.
    expect(report.files_created).toContain(".github/scripts/shard-mutation-scope.mjs");
    expect(existsSync(join(root, ".github", "scripts", "shard-mutation-scope.mjs"))).toBe(true);
    expect(report.files_updated).toEqual([]);
    expect(report.files_outdated).toEqual([]);
    // Per-run staging is no longer scaffold's concern — report carries no staging field.
    expect(report).not.toHaveProperty("staging");
    expect(report.protection.enabled).toBe(true);
    expect(report.protection.provisioned).toBe(false);

    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/\.claude-plugin-data\//);

    // E1: a target-repo .claude/settings.json is emitted with the factory
    // allow-list + the BAKED data-dir rules + worktree.baseRef:"head", and NO
    // statusLine — and crucially NO literal ${CLAUDE_PLUGIN_DATA} placeholder.
    expect(report.settings.created).toBe(true);
    const settingsRaw = await readFile(join(root, ".claude", "settings.json"), "utf8");
    expect(settingsRaw).not.toContain("${CLAUDE_PLUGIN_DATA}"); // the bug we fixed
    const settings = JSON.parse(settingsRaw) as Record<string, unknown>;
    expect((settings.worktree as { baseRef: string }).baseRef).toBe("head");
    const allow = (settings.permissions as { allow: string[] }).allow;
    expect(allow).toContain("Bash(factory:*)");
    expect(allow).toContain(`Read(${DATA_DIR_RULES.allowGlobBase}/**)`); // baked, resolved dir
    const dirs = (settings.permissions as { additionalDirectories: string[] })
      .additionalDirectories;
    expect(dirs).toContain(DATA_DIR_RULES.additionalDir);
    expect(settings).not.toHaveProperty("statusLine");
    expect(report.files_created).toContain(".claude/settings.json");
  });

  it("E1: merges non-destructively into an existing target .claude/settings.json", async () => {
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { command: "mine" }, permissions: { allow: ["Bash(make:*)"] } }),
      "utf8",
    );
    const report = await runScaffold({
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      dataDirRules: DATA_DIR_RULES,
      ghClient: new FakeGhClient({ protection: { [BASE]: PROTECTED } }),
      provision: false,
    });
    expect(report.settings.created).toBe(false);
    expect(report.settings.changed).toBe(true);
    const settings = JSON.parse(
      await readFile(join(root, ".claude", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(settings.statusLine).toEqual({ command: "mine" }); // user's own kept
    const allow = (settings.permissions as { allow: string[] }).allow;
    expect(allow).toContain("Bash(make:*)");
    expect(allow).toContain("Bash(factory:*)");
    expect(report.files_present).toContain(".claude/settings.json");
  });

  it("copies the Node gate configs ONLY when package.json exists", async () => {
    // No package.json → stryker/depcruise are skipped.
    const noPkg = await runScaffold({
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      dataDirRules: DATA_DIR_RULES,
      ghClient: new FakeGhClient({ protection: { [BASE]: PROTECTED } }),
      provision: false,
    });
    expect(noPkg.files_created).not.toContain(".stryker.config.json");
    expect(noPkg.files_created).not.toContain("eslint.config.mjs");
    expect(existsSync(join(root, ".stryker.config.json"))).toBe(false);

    // With package.json → both gate configs copied.
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    const withPkg = await runScaffold({
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      dataDirRules: DATA_DIR_RULES,
      ghClient: new FakeGhClient({ protection: { [BASE]: PROTECTED } }),
      provision: false,
    });
    expect(withPkg.files_created).toContain(".stryker.config.json");
    expect(withPkg.files_created).toContain(".dependency-cruiser.cjs");
    expect(withPkg.files_created).toContain("eslint.config.mjs");
  });

  it("is idempotent: a second run reports the files as present, not created", async () => {
    const args = {
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      dataDirRules: DATA_DIR_RULES,
      ghClient: new FakeGhClient({ protection: { [BASE]: PROTECTED } }),
      provision: false,
    };
    await runScaffold(args);
    const second = await runScaffold(args);
    expect(second.files_created).toEqual([]);
    expect(second.files_present).toContain(".github/workflows/quality-gate.yml");
    // An UNCHANGED managed file is `present`, not `updated`.
    expect(second.files_updated).toEqual([]);
  });

  it("auto-updates a drifted plugin-MANAGED file (the CI workflow) — propagation path", async () => {
    const args = {
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      dataDirRules: DATA_DIR_RULES,
      ghClient: new FakeGhClient({ protection: { [BASE]: PROTECTED } }),
      provision: false,
    };
    // Simulate an already-scaffolded repo carrying an OLD/customized workflow.
    const wf = join(root, ".github", "workflows", "quality-gate.yml");
    await mkdir(dirname(wf), { recursive: true });
    await writeFile(wf, "name: stale round-robin workflow\n", "utf8");

    const report = await runScaffold(args);

    expect(report.files_updated).toContain(".github/workflows/quality-gate.yml");
    expect(report.files_created).not.toContain(".github/workflows/quality-gate.yml");
    // Content was refreshed to the shipped template (the fix reaches the repo).
    const template = await readFile(
      join(templatesDir, ".github", "workflows", "quality-gate.yml"),
      "utf8",
    );
    expect(await readFile(wf, "utf8")).toBe(template);
  });

  it("leaves a drifted SEED config untouched and reports it advisory-outdated", async () => {
    const args = {
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      dataDirRules: DATA_DIR_RULES,
      ghClient: new FakeGhClient({ protection: { [BASE]: PROTECTED } }),
      provision: false,
    };
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await runScaffold(args); // seeds .stryker.config.json

    // The user customizes their (user-owned) gate config.
    const stryker = join(root, ".stryker.config.json");
    const customized = '{ "thresholds": { "break": 95 } }\n';
    await writeFile(stryker, customized, "utf8");

    const second = await runScaffold(args);
    expect(second.files_outdated).toContain(".stryker.config.json");
    expect(second.files_updated).not.toContain(".stryker.config.json");
    // Customization is preserved — SEED files are never overwritten.
    expect(await readFile(stryker, "utf8")).toBe(customized);
  });

  it("REFUSES loudly when develop protection is missing and --provision is off", async () => {
    await expect(
      runScaffold({
        targetRoot: root,
        templatesDir,
        owner: "acme",
        repo: "widgets",
        config: cfg,
        dataDirRules: DATA_DIR_RULES,
        ghClient: new FakeGhClient(), // no protection seeded → disabled
        provision: false,
      }),
    ).rejects.toThrow(/refuses to start|protection/i);
  });

  it("--provision writes protection then passes the gate", async () => {
    const gh = new FakeGhClient(); // starts unprotected
    const report = await runScaffold({
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      dataDirRules: DATA_DIR_RULES,
      ghClient: gh,
      provision: true,
    });
    expect(report.protection.provisioned).toBe(true);
    expect(report.protection.strict_up_to_date).toBe(true);
    // The PUT was issued against develop (the integration base), not a shared staging branch.
    expect(gh.calls).toContain(`api PUT protection ${BASE}`);
  });
});

describe("scaffoldCommand.run", () => {
  it("--help returns OK", async () => {
    const out: string[] = [];
    const spy = (c: unknown): boolean => (out.push(String(c)), true);
    const orig = process.stdout.write;
    (process.stdout as unknown as { write: typeof spy }).write = spy;
    try {
      expect(await scaffoldCommand.run(["--help"])).toBe(EXIT.OK);
    } finally {
      process.stdout.write = orig;
    }
    expect(out.join("")).toMatch(/factory scaffold/);
  });

  it("a malformed --repo is a USAGE error", async () => {
    const err: string[] = [];
    const spy = (c: unknown): boolean => (err.push(String(c)), true);
    const orig = process.stderr.write;
    (process.stderr as unknown as { write: typeof spy }).write = spy;
    try {
      expect(await scaffoldCommand.run(["--repo", "no-slash"])).toBe(EXIT.USAGE);
    } finally {
      process.stderr.write = orig;
    }
    expect(err.join("")).toMatch(/owner.*name/i);
  });
});

describe("resolveScaffoldRepo (auto-derive --repo from origin)", () => {
  function gitWithOrigin(slug: string | null): FakeGitClient {
    const git = new FakeGitClient();
    if (slug !== null) git.setRemoteUrl("origin", `git@github.com:${slug}.git`);
    return git;
  }

  it("no --repo flag → derives owner/name from the origin remote", async () => {
    const { owner, repo } = await resolveScaffoldRepo(
      parseArgs(["--provision"], { booleans: ["provision"] }),
      { gitClient: gitWithOrigin("acme/widgets"), cwd: "/wherever" },
    );
    expect(owner).toBe("acme");
    expect(repo).toBe("widgets");
  });

  it("an explicit --repo that MISMATCHES the origin fails LOUD naming both", async () => {
    await expect(
      resolveScaffoldRepo(parseArgs(["--repo", "acme/other"]), {
        gitClient: gitWithOrigin("acme/widgets"),
        cwd: "/wherever",
      }),
    ).rejects.toThrow(/acme\/other.*acme\/widgets|acme\/widgets.*acme\/other/s);
  });

  it("no --repo and NO origin → fails LOUD telling the user to pass --repo", async () => {
    await expect(
      resolveScaffoldRepo(parseArgs([]), { gitClient: gitWithOrigin(null), cwd: "/wherever" }),
    ).rejects.toThrow(/--repo/);
  });
});
