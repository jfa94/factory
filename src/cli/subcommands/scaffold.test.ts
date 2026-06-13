/**
 * Unit tests for `factory scaffold`. Drives the injectable {@link runScaffold} core
 * with fake git/gh clients + a temp target repo + the REAL templates dir, so the
 * template copy, staging-ensure, and protection probe/refuse/provision are all
 * exercised without touching the host repo or the network.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runScaffold, resolveTemplatesDir, scaffoldCommand } from "./scaffold.js";
import { EXIT } from "../exit-codes.js";
import { defaultConfig } from "../../config/index.js";
import { FakeGitClient, FakeGhClient } from "../../git/index.js";
import type { ProtectionApiResult } from "../../git/index.js";

const cfg = defaultConfig();
const STAGING = cfg.git.stagingBranch; // "staging"
const BASE = cfg.git.baseBranch; // "develop"

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

/** A git client with base seeded so ensureStaging can create staging from it. */
function gitWithBase(): FakeGitClient {
  return new FakeGitClient({ remoteHeads: { [BASE]: "sha-base-1" } });
}

describe("runScaffold", () => {
  it("copies the CI template + manages .gitignore, and reports a protected staging", async () => {
    const report = await runScaffold({
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      gitClient: gitWithBase(),
      ghClient: new FakeGhClient({ protection: { [STAGING]: PROTECTED } }),
      provision: false,
    });

    expect(existsSync(join(root, ".github", "workflows", "quality-gate.yml"))).toBe(true);
    expect(existsSync(join(root, ".gitignore"))).toBe(true);
    expect(report.files_created).toContain(".github/workflows/quality-gate.yml");
    expect(report.staging.created).toBe(true);
    expect(report.protection.enabled).toBe(true);
    expect(report.protection.provisioned).toBe(false);

    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/\.claude-plugin-data\//);
  });

  it("copies the Node gate configs ONLY when package.json exists", async () => {
    // No package.json → stryker/depcruise are skipped.
    const noPkg = await runScaffold({
      targetRoot: root,
      templatesDir,
      owner: "acme",
      repo: "widgets",
      config: cfg,
      gitClient: gitWithBase(),
      ghClient: new FakeGhClient({ protection: { [STAGING]: PROTECTED } }),
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
      gitClient: gitWithBase(),
      ghClient: new FakeGhClient({ protection: { [STAGING]: PROTECTED } }),
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
      ghClient: new FakeGhClient({ protection: { [STAGING]: PROTECTED } }),
      provision: false,
    };
    await runScaffold({ ...args, gitClient: gitWithBase() });
    const second = await runScaffold({ ...args, gitClient: gitWithBase() });
    expect(second.files_created).toEqual([]);
    expect(second.files_present).toContain(".github/workflows/quality-gate.yml");
  });

  it("REFUSES loudly when staging protection is missing and --provision is off", async () => {
    await expect(
      runScaffold({
        targetRoot: root,
        templatesDir,
        owner: "acme",
        repo: "widgets",
        config: cfg,
        gitClient: gitWithBase(),
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
      gitClient: gitWithBase(),
      ghClient: gh,
      provision: true,
    });
    expect(report.protection.provisioned).toBe(true);
    expect(report.protection.strict_up_to_date).toBe(true);
    // The PUT was issued against the staging branch.
    expect(gh.calls).toContain(`api PUT protection ${STAGING}`);
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
