/**
 * `factory scaffold` — prepare a target repo to be run by the factory (WS3 / Δ A).
 *
 *   factory scaffold --repo <owner/name> [--provision]
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
import { parseArgs, isUsageError, UsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { createLogger } from "../../shared/index.js";
import {
  DefaultGitClient,
  DefaultGhClient,
  ensureStaging,
  probeProtection,
  requireProtectionOrRefuse,
  provisionProtection,
  type GitClient,
  type GhClient,
} from "../../git/index.js";
import { loadConfig, type Config } from "../../config/index.js";
import type { Subcommand } from "../main.js";

const log = createLogger("scaffold");

const HELP = `factory scaffold — prepare a repo for the factory pipeline

Usage:
  factory scaffold --repo <owner/name> [--provision]

Copies the committed CI + gate-config templates, ensures the staging branch, and
probes branch protection. Without --provision a repo whose staging branch is not
protected (strict up-to-date + required checks) causes scaffold to REFUSE loudly.

Options:
  --repo <owner/name>   Target GitHub repo (required; used for the protection probe)
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
  };
}

/** Parse `<owner>/<name>` into its parts (loud on a malformed value). */
function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const parts = slug.split("/");
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) {
    throw new UsageError(`--repo must be '<owner>/<name>', got '${slug}'`);
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

async function run(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: ["provision"] });
  if (args.flag("help") === true) {
    emitLine(HELP);
    return EXIT.OK;
  }

  const { owner, repo } = parseRepoSlug(args.requireFlag("repo"));
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
