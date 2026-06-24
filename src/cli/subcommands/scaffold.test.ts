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
import { EXIT } from "../../shared/exit-codes.js";
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
let dataDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "factory-scaffold-"));
  // Isolated config-overlay dir so CI build-env detection's gateEnv write (and the
  // no-op read when nothing is detected) never touches the host data dir.
  dataDir = await mkdtemp(join(tmpdir(), "factory-scaffold-data-"));
  templatesDir = resolveTemplatesDir();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
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
      dataDir,
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
    // The advisory `files_outdated` bucket was retired with the project-owned SEED
    // model (Decision 15) — a SEED file is either created or present, never "outdated".
    expect(report).not.toHaveProperty("files_outdated");
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
      dataDir,
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
      dataDir,
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
      dataDir,
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
      dataDir,
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
      dataDir,
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

  it("treats an existing SEED config as project-owned: present, never overwritten, never re-flagged", async () => {
    const args = {
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      dataDirRules: DATA_DIR_RULES,
      dataDir,
      ghClient: new FakeGhClient({ protection: { [BASE]: PROTECTED } }),
      provision: false,
    };
    await writeFile(join(root, "package.json"), "{}\n", "utf8");
    await runScaffold(args); // seeds .stryker.config.json

    // The project grows its own (user-owned) gate config — exactly the outsidey
    // case where the repo's config has diverged into a richer superset.
    const stryker = join(root, ".stryker.config.json");
    const customized = '{ "thresholds": { "break": 95 } }\n';
    await writeFile(stryker, customized, "utf8");

    const second = await runScaffold(args);
    // A present SEED file is project-owned: reported `present`, NOT created/updated,
    // and there is no advisory "outdated" bucket to land in.
    expect(second.files_present).toContain(".stryker.config.json");
    expect(second.files_created).not.toContain(".stryker.config.json");
    expect(second.files_updated).not.toContain(".stryker.config.json");
    expect(second).not.toHaveProperty("files_outdated");
    // Customization is preserved — SEED files are never overwritten.
    expect(await readFile(stryker, "utf8")).toBe(customized);
  });

  it("guarantees the explicit TRACKED/IGNORED .gitignore split", async () => {
    const args = {
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      dataDirRules: DATA_DIR_RULES,
      dataDir,
      ghClient: new FakeGhClient({ protection: { [BASE]: PROTECTED } }),
      provision: false,
    };
    await runScaffold(args);
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    const lines = gitignore.split("\n");

    // IGNORED: per-machine local state + factory/worktree state are guaranteed.
    for (const entry of [
      ".claude/settings.local.json",
      ".claude/worktrees/",
      ".claude/projects/",
      ".claude/tool-audit.jsonl",
      ".claude-plugin-data/",
      "*.worktree",
    ]) {
      expect(lines).toContain(entry);
    }
    // TRACKED: `.claude/settings.json` must NOT be ignored — neither by an exact
    // line nor by a wholesale `.claude/` rule. The split is explicit, never reliant
    // on enumerating siblings or a global excludes file.
    expect(lines).not.toContain(".claude/settings.json");
    expect(lines).not.toContain(".claude/");
    expect(lines).not.toContain(".claude/*");

    // Idempotent + non-duplicating: a second run appends nothing.
    await runScaffold(args);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(gitignore);
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
        dataDir,
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
      dataDir,
      ghClient: gh,
      provision: true,
    });
    expect(report.protection.provisioned).toBe(true);
    expect(report.protection.strict_up_to_date).toBe(true);
    // The PUT was issued against develop (the integration base), not a shared staging branch.
    expect(gh.calls).toContain(`api PUT protection ${BASE}`);
  });

  it("auto-detects the repo's CI build env into quality.gateEnv BEFORE the managed template overwrites it", async () => {
    // The repo ships its OWN quality-gate.yml carrying build placeholders. scaffold
    // MANAGES (overwrites) that file — so detection must capture the env into the
    // durable config overlay first. Mirror goodbyespy: a literal build env + a
    // `${{ secrets.* }}` ref that must be dropped.
    const wfDir = join(root, ".github", "workflows");
    await mkdir(wfDir, { recursive: true });
    await writeFile(
      join(wfDir, "quality-gate.yml"),
      `jobs:
  quality:
    steps:
      - run: pnpm build
        env:
          NEXT_PUBLIC_SUPABASE_URL: http://localhost:54321
          DEPLOY_TOKEN: \${{ secrets.DEPLOY_TOKEN }}
`,
      "utf8",
    );

    const report = await runScaffold({
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      dataDirRules: DATA_DIR_RULES,
      dataDir,
      ghClient: new FakeGhClient({ protection: { [BASE]: PROTECTED } }),
      provision: false,
    });

    // The literal placeholder was captured; the secret ref was dropped.
    expect(report.gateEnv?.gateEnv.NEXT_PUBLIC_SUPABASE_URL).toBe("http://localhost:54321");
    expect(report.gateEnv?.written).toEqual(["NEXT_PUBLIC_SUPABASE_URL"]);
    expect(report.gateEnv?.skippedExpressionRefs.map((r) => r.key)).toEqual(["DEPLOY_TOKEN"]);

    // It landed in the durable overlay (the same one the rest of the factory reads).
    const overlay = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8"));
    expect(overlay.quality.gateEnv).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    });

    // The managed template DID overwrite the repo's workflow afterward — proving the
    // ordering: detect first, then clobber.
    expect(report.files_updated).toContain(".github/workflows/quality-gate.yml");
  });

  it("omits the gateEnv report field when the repo has no detectable build env", async () => {
    const report = await runScaffold({
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      dataDirRules: DATA_DIR_RULES,
      dataDir,
      ghClient: new FakeGhClient({ protection: { [BASE]: PROTECTED } }),
      provision: false,
    });
    expect(report).not.toHaveProperty("gateEnv");
    expect(existsSync(join(dataDir, "config.json"))).toBe(false);
  });

  const baseArgs = () => ({
    targetRoot: root,
    templatesDir,
    owner: "acme",
    repo: "widgets",
    config: cfg,
    dataDirRules: DATA_DIR_RULES,
    dataDir,
    ghClient: new FakeGhClient({ protection: { [BASE]: PROTECTED } }),
    provision: false,
  });

  const writeRepoWorkflow = async (text: string) => {
    const wfDir = join(root, ".github", "workflows");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "quality-gate.yml"), text, "utf8");
  };

  const GATEENV_WF = `jobs:
  quality:
    steps:
      - run: pnpm build
        env:
          NEXT_PUBLIC_SUPABASE_URL: http://localhost:54321
`;

  it("injects the resolved gateEnv into the WRITTEN managed quality-gate.yml (CI parity)", async () => {
    await writeRepoWorkflow(GATEENV_WF);
    const report = await runScaffold(baseArgs());

    const written = await readFile(join(root, ".github", "workflows", "quality-gate.yml"), "utf8");
    // The marker became a real env: block carrying the detected placeholder (quoted).
    expect(written).not.toContain("# factory:gate-env");
    expect(written).toContain('          NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321"');
    expect(report.gateEnv?.gateEnv.NEXT_PUBLIC_SUPABASE_URL).toBe("http://localhost:54321");
  });

  it("leaves the gate-env marker in place when there is no detectable build env", async () => {
    await runScaffold(baseArgs());
    const written = await readFile(join(root, ".github", "workflows", "quality-gate.yml"), "utf8");
    // No injection happened — the marker survives for a future scaffold to fill.
    expect(written).toContain("# factory:gate-env");
  });

  it("re-scaffold re-injects a byte-identical file (idempotent round-trip, no spurious update)", async () => {
    await writeRepoWorkflow(GATEENV_WF);
    await runScaffold(baseArgs()); // detect + overwrite + inject
    const wf = join(root, ".github", "workflows", "quality-gate.yml");
    const first = await readFile(wf, "utf8");

    const second = await runScaffold(baseArgs()); // re-detect injected env (skipped) + re-inject
    expect(await readFile(wf, "utf8")).toBe(first);
    expect(second.files_updated).not.toContain(".github/workflows/quality-gate.yml");
  });

  it("surfaces an unparseable workflow in the report (warnings) instead of swallowing it", async () => {
    // Tab indentation → MalformedWorkflow → the file is skipped with a warning. The
    // report MUST still carry the gateEnv field so the parse failure isn't silent (the
    // CRITICAL omission-gate fix), even though nothing was detected.
    const wfDir = join(root, ".github", "workflows");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "bad.yml"), "jobs:\n\tj:\n\t\tsteps:\n", "utf8");

    const report = await runScaffold(baseArgs());
    expect(report.gateEnv).toBeDefined();
    expect(report.gateEnv?.warnings.map((w) => w.workflow)).toContain("bad.yml");
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

describe("dependency-cruiser template content", () => {
  it("seeds the architectural boundary rules, incl. lib-not-to-app + components-no-app", async () => {
    const cjs = await readFile(join(resolveTemplatesDir(), ".dependency-cruiser.cjs"), "utf8");
    expect(cjs).toContain("lib-not-to-app");
    expect(cjs).toContain("components-no-app");
    // The exemption that keeps Next.js server actions a legal cross-layer boundary.
    expect(cjs).toContain("^src/app/actions");
  });
});
