/**
 * `factory scaffold` — prepare a target repo to be run by the factory (WS3 / Δ A).
 *
 *   factory scaffold [--repo <owner/name>] [--provision]
 *
 * `--repo` is OPTIONAL (Prompt G / F-repo): auto-derived from the `origin` remote
 * when omitted (the CLI is always cwd-rooted in the target repo).
 *
 * Idempotently copies the per-repo COMMITTED artifacts the new design consumes —
 * the CI net (`.github/workflows/quality-gate.yml`, Δ Z) and the gate configs
 * (`.stryker.config.json` mutation, `.dependency-cruiser.cjs` arch, `eslint.config.mjs`
 * lint baseline) the GateRunner runs in the target worktree — plus a `.gitignore`
 * guard, then ensures the
 * `staging` integration branch exists/reconciles (never `main`), and PROBES branch
 * protection: refuse-to-run when it is missing (#2 / Δ A), unless `--provision` is
 * opted in to write it.
 *
 * Run/spec STATE is never written here (it lives outside the repo under the data
 * dir). The bash-era progress files + init.sh are dropped — the new code does not
 * read them; partial-run reporting lands in WS12.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { createLogger } from "../../shared/index.js";
import {
  DefaultGitClient,
  DefaultGhClient,
  ensureStaging,
  probeProtection,
  requireProtectionOrRefuse,
  provisionProtection,
  resolveRepo,
  splitRepoSlug,
  type GitClient,
  type GhClient,
} from "../../git/index.js";
import { loadConfig, type Config } from "../../config/index.js";
import { ensureTargetSettings } from "./target-settings.js";
import type { Subcommand } from "../main.js";

const log = createLogger("scaffold");

const HELP = `factory scaffold — prepare a repo for the factory pipeline

Usage:
  factory scaffold [--repo <owner/name>] [--provision]

Copies the committed CI + gate-config templates, ensures the staging branch, and
probes branch protection. Without --provision a repo whose staging branch is not
protected (strict up-to-date + required checks) causes scaffold to REFUSE loudly.

Options:
  --repo <owner/name>   OPTIONAL. Target GitHub repo (used for the protection probe).
                        Auto-derived from the 'origin' remote when omitted; an
                        explicit value disagreeing with the remote fails loud.
  --provision           Write branch protection if missing (default: refuse)`;

/** The `.gitignore` lines scaffold guarantees (factory state must stay un-committed). */
const GITIGNORE_ENTRIES = ["# factory plugin state", ".claude-plugin-data/", "*.worktree"];

/** Injectable inputs to the scaffold CORE (the `run(argv)` wrapper wires real ones). */
export interface ScaffoldOptions {
  /** The repo working tree to scaffold (defaults to cwd in the CLI wrapper). */
  readonly targetRoot: string;
  /** The plugin `templates/` dir (resolved from the bundle location by default). */
  readonly templatesDir: string;
  readonly owner: string;
  readonly repo: string;
  readonly config: Config;
  readonly gitClient: GitClient;
  readonly ghClient: GhClient;
  /** --provision: write protection when missing instead of refusing. */
  readonly provision: boolean;
}

/** Machine-readable scaffold report (emitted as JSON). */
export interface ScaffoldReport {
  readonly repo: string;
  readonly files_created: string[];
  readonly files_present: string[];
  readonly staging: { readonly created: boolean; readonly staging_tip: string };
  readonly protection: {
    readonly enabled: boolean;
    readonly strict_up_to_date: boolean;
    readonly required_status_checks: string[];
    readonly provisioned: boolean;
  };
  /**
   * E1 (F-perm): the target `.claude/settings.json` emit/merge — whether the
   * file was freshly created and whether the merge altered it. Stops the
   * per-call permission prompts for interactive `/factory:run` in this repo.
   */
  readonly settings: { readonly created: boolean; readonly changed: boolean };
}

/**
 * Resolve the plugin `templates/` directory from this module's runtime location.
 * The build inlines this module into `dist/factory.js` (repo root → `templates/`);
 * in dev it runs from `src/cli/subcommands/` (four up → `templates/`). Walk up
 * until a dir with the CI template is found.
 */
export function resolveTemplatesDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "templates");
    if (existsSync(join(candidate, ".github", "workflows", "quality-gate.yml"))) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("scaffold: could not locate the plugin templates/ directory");
}

/** Copy `src`→`dest` only when `dest` is absent; record into created/present. */
async function copyIfAbsent(
  src: string,
  dest: string,
  root: string,
  created: string[],
  present: string[],
): Promise<void> {
  const rel = relative(root, dest);
  if (!existsSync(src)) {
    log.warn(`template missing, skipping: ${src}`);
    return;
  }
  if (existsSync(dest)) {
    present.push(rel);
    return;
  }
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  created.push(rel);
}

/** Append any missing {@link GITIGNORE_ENTRIES} to the target `.gitignore`. */
async function ensureGitignore(root: string, created: string[], present: string[]): Promise<void> {
  const path = join(root, ".gitignore");
  const rel = relative(root, path);
  if (!existsSync(path)) {
    await writeFile(path, GITIGNORE_ENTRIES.join("\n") + "\n", "utf8");
    created.push(rel);
    return;
  }
  const current = await readFile(path, "utf8");
  const missing = GITIGNORE_ENTRIES.filter((e) => !current.split("\n").includes(e));
  if (missing.length === 0) {
    present.push(rel);
    return;
  }
  const sep = current.endsWith("\n") ? "" : "\n";
  await writeFile(path, current + sep + missing.join("\n") + "\n", "utf8");
  present.push(rel);
}

/**
 * The scaffold CORE: copy templates, ensure staging, probe/refuse/provision
 * protection. Pure of `process`/argv — driven by {@link ScaffoldOptions} so units
 * exercise it with fakes + temp dirs. Throws loud on a protection shortfall when
 * `--provision` is not set, or on a staging divergence.
 */
export async function runScaffold(opts: ScaffoldOptions): Promise<ScaffoldReport> {
  const created: string[] = [];
  const present: string[] = [];

  // 1. CI net (Δ Z) — always.
  await copyIfAbsent(
    join(opts.templatesDir, ".github", "workflows", "quality-gate.yml"),
    join(opts.targetRoot, ".github", "workflows", "quality-gate.yml"),
    opts.targetRoot,
    created,
    present,
  );

  // 2. Gate configs — only when the target is a Node package (mirrors the gates).
  if (existsSync(join(opts.targetRoot, "package.json"))) {
    await copyIfAbsent(
      join(opts.templatesDir, ".stryker.config.json"),
      join(opts.targetRoot, ".stryker.config.json"),
      opts.targetRoot,
      created,
      present,
    );
    await copyIfAbsent(
      join(opts.templatesDir, ".dependency-cruiser.cjs"),
      join(opts.targetRoot, ".dependency-cruiser.cjs"),
      opts.targetRoot,
      created,
      present,
    );
    // Default eslint flat config — a baseline so the lint gate becomes meaningful
    // the moment a project installs eslint (the gate skips until both are present).
    await copyIfAbsent(
      join(opts.templatesDir, "eslint.config.mjs"),
      join(opts.targetRoot, "eslint.config.mjs"),
      opts.targetRoot,
      created,
      present,
    );
  }

  // 3. .gitignore guard (factory state must never be committed).
  await ensureGitignore(opts.targetRoot, created, present);

  // 3b. E1 (F-perm): emit / idempotently merge the target-repo
  //     `.claude/settings.json` (factory allow-list + worktree.baseRef:"head";
  //     NO statusLine — that belongs to E2's merged-settings). Non-destructive:
  //     a user's existing settings keys (incl. their own statusLine) are kept.
  const settings = await ensureTargetSettings({ targetRoot: opts.targetRoot });
  // Surface the .claude/settings.json path in the file lists for transparency.
  const settingsRel = relative(opts.targetRoot, settings.path);
  if (settings.created) created.push(settingsRel);
  else present.push(settingsRel);

  // 4. staging branch (created from base — develop, never main — or FF-reconciled).
  const staging = await ensureStaging({
    gitClient: opts.gitClient,
    stagingBranch: opts.config.git.stagingBranch,
    baseBranch: opts.config.git.baseBranch,
    cwd: opts.targetRoot,
  });

  // 5. branch protection: probe → refuse-if-missing, OR provision when opted in.
  const branch = opts.config.git.stagingBranch;
  const required = opts.config.git.requiredStatusChecks;
  let state = await probeProtection({
    ghClient: opts.ghClient,
    owner: opts.owner,
    repo: opts.repo,
    branch,
  });
  let provisioned = false;
  if (opts.provision) {
    state = await provisionProtection({
      ghClient: opts.ghClient,
      owner: opts.owner,
      repo: opts.repo,
      branch,
      requiredChecks: required,
      provision: true,
    });
    provisioned = true;
  }
  // Assert the gate in both paths: a post-provision re-probe must satisfy it too.
  requireProtectionOrRefuse(state, required, branch);

  return {
    repo: `${opts.owner}/${opts.repo}`,
    files_created: created,
    files_present: present,
    staging: { created: staging.created, staging_tip: staging.stagingTip },
    protection: {
      enabled: state.enabled,
      strict_up_to_date: state.strictUpToDate,
      required_status_checks: state.requiredStatusChecks,
      provisioned,
    },
    settings: { created: settings.created, changed: settings.changed },
  };
}

/**
 * Test seam for {@link run}'s repo resolution: inject the git seam + cwd so the
 * auto-derive path (Prompt G) is exercised with a fake remote. Production passes
 * the real {@link DefaultGitClient} + `process.cwd()`.
 */
export interface ScaffoldRepoOverrides {
  readonly gitClient?: GitClient;
  readonly cwd?: string;
}

/**
 * Resolve the scaffold target's `<owner>/<name>` — `--repo` is OPTIONAL (Prompt G),
 * auto-derived from the origin remote when omitted; an explicit value that
 * disagrees with the remote fails loud.
 */
export async function resolveScaffoldRepo(
  args: ReturnType<typeof parseArgs>,
  overrides: ScaffoldRepoOverrides = {},
): Promise<{ owner: string; repo: string }> {
  const slug = await resolveRepo({
    explicit: optionalString(args.flag("repo")),
    cwd: overrides.cwd ?? process.cwd(),
    gitClient: overrides.gitClient ?? new DefaultGitClient(),
  });
  return splitRepoSlug(slug);
}

/** Coerce a flag to a non-empty string, treating a bare boolean flag as absent. */
function optionalString(raw: string | boolean | undefined): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

async function run(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: ["provision"] });
  if (args.flag("help") === true) {
    emitLine(HELP);
    return EXIT.OK;
  }

  const { owner, repo } = await resolveScaffoldRepo(args);
  const report = await runScaffold({
    targetRoot: process.cwd(),
    templatesDir: resolveTemplatesDir(),
    owner,
    repo,
    config: loadConfig(),
    gitClient: new DefaultGitClient(),
    ghClient: new DefaultGhClient(),
    provision: args.flag("provision") === true,
  });
  emitJson(report);
  return EXIT.OK;
}

export const scaffoldCommand: Subcommand = {
  describe: "Prepare a repo (templates + staging + branch protection) for the pipeline",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`scaffold: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
