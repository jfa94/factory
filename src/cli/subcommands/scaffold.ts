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
 * guard, then PROBES branch protection on `develop` (the integration base):
 * refuse-to-run when it is missing (#2 / Δ A), unless `--provision` is opted in to
 * write it. Per-run staging branches (`staging-<run-id>`) are minted at `run create`
 * — scaffold no longer creates or protects a shared `staging` branch.
 *
 * Run/spec STATE is never written here (it lives outside the repo under the data
 * dir). The bash-era progress files + init.sh are dropped — the new code does not
 * read them; partial-run reporting lands in WS12.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT, type ExitCode } from "../../shared/exit-codes.js";
import { parseArgs, isUsageError, optionalString } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { createLogger } from "../../shared/index.js";
import {
  DefaultGitClient,
  DefaultGhClient,
  probeProtection,
  requireProtectionOrRefuse,
  provisionProtection,
  resolveRepo,
  splitRepoSlug,
  type GitClient,
  type GhClient,
} from "../../git/index.js";
import { loadConfig, resolveDataDir, type Config } from "../../config/index.js";
import {
  ensureTargetSettings,
  buildTargetDataDirRules,
  type TargetDataDirRules,
} from "./target-settings.js";
import type { Subcommand } from "../registry-types.js";

const log = createLogger("scaffold");

const HELP = `factory scaffold — prepare a repo for the factory pipeline

Usage:
  factory scaffold [--repo <owner/name>] [--provision]

Copies the committed CI + gate-config templates and probes branch protection on
develop (the integration base). Without --provision a repo whose develop branch is
not protected (strict up-to-date + required checks) causes scaffold to REFUSE loudly.
Per-run staging branches are minted at run create — scaffold no longer touches them.

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
  readonly ghClient: GhClient;
  /**
   * The baked, CLI-resolved data-dir permission rules for the target repo's
   * `.claude/settings.json` (from {@link buildTargetDataDirRules}). Injected at
   * the command boundary — `run(argv)` resolves the canonical data dir via
   * `resolveDataDir()` (which corrects the foreign-plugin env-var leak) so the
   * emitted rules never carry the broken `${CLAUDE_PLUGIN_DATA}` placeholder.
   */
  readonly dataDirRules: TargetDataDirRules;
  /** --provision: write protection when missing instead of refusing. */
  readonly provision: boolean;
}

/** Machine-readable scaffold report (emitted as JSON). */
export interface ScaffoldReport {
  readonly repo: string;
  readonly files_created: string[];
  readonly files_present: string[];
  /**
   * Plugin-MANAGED template files (the CI net) that drifted from the shipped
   * template and were AUTO-OVERWRITTEN on this run. The plugin is their sole
   * author; git is the safety net (the change shows in `git diff`).
   */
  readonly files_updated: string[];
  /**
   * SEED template files (user-owned configs) present but differing from the
   * current shipped template — advisory only; never overwritten. A drift here
   * is usually a deliberate customization.
   */
  readonly files_outdated: string[];
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

/**
 * Per-file scaffold policy (the user's "plugin-managed vs user-owned" split):
 *
 *   - `managed` — the plugin is the SOLE author (the CI net + its helper script).
 *     Auto-overwritten when it drifts from the shipped template so a template fix
 *     reaches already-scaffolded repos on the next `factory scaffold`. Git is the
 *     safety net; customizing a managed file is unsupported by contract.
 *   - `seed` — copied once if absent, then USER-OWNED. Never overwritten (Decision
 *     15: don't destroy customizations); drift is reported advisory-only.
 */
type TemplatePolicy = "managed" | "seed";

interface TemplateEntry {
  /** Path relative to BOTH `templatesDir` and `targetRoot` (forward-slashed). */
  readonly rel: string;
  readonly policy: TemplatePolicy;
  /** Only scaffold this file when the target is a Node package (has package.json). */
  readonly nodeOnly?: boolean;
}

/**
 * The committed per-repo artifacts the factory consumes. The CI workflow and its
 * cost-aware shard helper are MANAGED (plugin-authored, auto-updated); the gate
 * configs are SEED (a starting point the project then owns + tunes).
 */
const TEMPLATE_MANIFEST: readonly TemplateEntry[] = [
  { rel: ".github/workflows/quality-gate.yml", policy: "managed" },
  { rel: ".github/scripts/shard-mutation-scope.mjs", policy: "managed" },
  { rel: ".stryker.config.json", policy: "seed", nodeOnly: true },
  { rel: ".dependency-cruiser.cjs", policy: "seed", nodeOnly: true },
  { rel: "eslint.config.mjs", policy: "seed", nodeOnly: true },
];

/** Mutable file buckets a scaffold run accumulates, surfaced in the report. */
interface FileLists {
  readonly created: string[];
  readonly present: string[];
  readonly updated: string[];
  readonly outdated: string[];
}

/**
 * Apply one {@link TemplateEntry}: create when absent; for a present file, leave
 * it (and record drift) under the `seed` policy, or overwrite it under `managed`.
 * Each file lands in exactly one bucket.
 */
async function applyTemplate(
  entry: TemplateEntry,
  templatesDir: string,
  targetRoot: string,
  lists: FileLists,
): Promise<void> {
  const segs = entry.rel.split("/");
  const src = join(templatesDir, ...segs);
  const dest = join(targetRoot, ...segs);
  if (!existsSync(src)) {
    log.warn(`template missing, skipping: ${src}`);
    return;
  }
  if (!existsSync(dest)) {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    lists.created.push(entry.rel);
    return;
  }
  const [srcText, destText] = await Promise.all([readFile(src, "utf8"), readFile(dest, "utf8")]);
  if (srcText === destText) {
    lists.present.push(entry.rel);
    return;
  }
  if (entry.policy === "managed") {
    await copyFile(src, dest); // sole-author file drifted → refresh it
    lists.updated.push(entry.rel);
  } else {
    lists.outdated.push(entry.rel); // user-owned drift → advisory, never clobber
  }
}

/** Append any missing {@link GITIGNORE_ENTRIES} to the target `.gitignore`. */
async function ensureGitignore(root: string, lists: FileLists): Promise<void> {
  const path = join(root, ".gitignore");
  const rel = relative(root, path);
  if (!existsSync(path)) {
    await writeFile(path, GITIGNORE_ENTRIES.join("\n") + "\n", "utf8");
    lists.created.push(rel);
    return;
  }
  const current = await readFile(path, "utf8");
  const missing = GITIGNORE_ENTRIES.filter((e) => !current.split("\n").includes(e));
  if (missing.length === 0) {
    lists.present.push(rel);
    return;
  }
  const sep = current.endsWith("\n") ? "" : "\n";
  await writeFile(path, current + sep + missing.join("\n") + "\n", "utf8");
  lists.present.push(rel);
}

/**
 * The scaffold CORE: copy templates, probe/refuse/provision protection on
 * `develop` (the integration base). Pure of `process`/argv — driven by
 * {@link ScaffoldOptions} so units exercise it with fakes + temp dirs. Throws
 * loud on a protection shortfall when `--provision` is not set.
 *
 * Per-run staging branches (`staging-<run-id>`) are minted at `run create` —
 * scaffold no longer creates or protects a shared `staging` branch.
 */
export async function runScaffold(opts: ScaffoldOptions): Promise<ScaffoldReport> {
  const lists: FileLists = { created: [], present: [], updated: [], outdated: [] };

  // 1+2. Committed template artifacts (Δ Z). MANAGED files (the CI net + its shard
  //       helper) auto-update on drift; SEED gate configs are copy-once + user-owned.
  //       The `nodeOnly` SEED configs apply only to a Node-package target.
  const isNodePackage = existsSync(join(opts.targetRoot, "package.json"));
  for (const entry of TEMPLATE_MANIFEST) {
    if (entry.nodeOnly && !isNodePackage) continue;
    await applyTemplate(entry, opts.templatesDir, opts.targetRoot, lists);
  }
  // Surface auto-updated plugin-managed files (e.g. the CI workflow refreshed in a
  // previously-scaffolded repo) — these are the propagation path, worth a loud line.
  if (lists.updated.length > 0) {
    log.info(
      `auto-updated ${lists.updated.length} plugin-managed file(s): ${lists.updated.join(", ")}`,
    );
  }

  // 3. .gitignore guard (factory state must never be committed).
  await ensureGitignore(opts.targetRoot, lists);

  // 3b. E1 (F-perm): emit / idempotently merge the target-repo
  //     `.claude/settings.json` (factory allow-list + baked data-dir rules +
  //     worktree.baseRef:"head"; NO statusLine — that belongs to E2's
  //     merged-settings). Non-destructive: a user's existing settings keys (incl.
  //     their own statusLine) are kept, and any stale `${CLAUDE_PLUGIN_DATA}`
  //     placeholder rules from an older scaffold are migrated to the baked form.
  const settings = await ensureTargetSettings({
    targetRoot: opts.targetRoot,
    dataDirRules: opts.dataDirRules,
  });
  // Surface the .claude/settings.json path in the file lists for transparency.
  const settingsRel = relative(opts.targetRoot, settings.path);
  if (settings.created) lists.created.push(settingsRel);
  else lists.present.push(settingsRel);

  // 4. branch protection on develop: probe → refuse-if-missing, OR provision when opted in.
  //    develop is a PRECONDITION — scaffold does not create it (a missing develop
  //    makes the probe fail loud, which is acceptable).
  const branch = opts.config.git.baseBranch;
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
    files_created: lists.created,
    files_present: lists.present,
    files_updated: lists.updated,
    files_outdated: lists.outdated,
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
    ghClient: new DefaultGhClient(),
    // Resolve the CANONICAL data dir at the command boundary (corrects the
    // foreign-plugin env-var leak) and bake it into the target permission rules.
    // resolveDataDir() throwing on an unresolvable dir is the correct loud
    // failure — there is deliberately no placeholder fallback.
    dataDirRules: buildTargetDataDirRules({ dataDir: resolveDataDir(), home: homedir() }),
    provision: args.flag("provision") === true,
  });
  emitJson(report);
  return EXIT.OK;
}

export const scaffoldCommand: Subcommand = {
  describe: "Prepare a repo (templates + develop branch protection) for the pipeline",
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
