/**
 * E2 (full-autonomy port) — `factory autonomy ensure`.
 *
 * Ports the old `bin/pipeline-ensure-autonomy` regenerate step to the Node CLI.
 * It materializes `${CLAUDE_PLUGIN_DATA}/merged-settings.json` from
 * `templates/settings.autonomous.json` merged with the user's existing settings,
 * then prints the `claude --settings <merged-settings.json>` relaunch command.
 * A session relaunched with it runs in autonomous mode and — because the
 * template wires `statusLine → factory statusline` — produces a fresh
 * usage-cache.json (the session-mode quota pacer's input) on the first turn.
 *
 * What the old bash did → what this ports:
 *   - read template + walk()-substitute ${CLAUDE_PLUGIN_ROOT} /
 *     ${CLAUDE_PLUGIN_DATA} / ${CLAUDE_PLUGIN_DATA_TILDE}  → {@link substitutePlaceholders}.
 *   - bake .env.CLAUDE_PLUGIN_DATA                          → {@link materializeMergedSettings}.
 *   - detect the user's statusLine and chain it via            (ditto)
 *     FACTORY_ORIGINAL_STATUSLINE.
 *   - stamp ._factoryVersion                                → (ditto, from plugin.json).
 *   - write atomically                                      → {@link runAutonomyEnsure}.
 *
 * What the old bash did that is DROPPED (deliberately):
 *   - the wrapper stable-path COPY (`cp statusline-wrapper.sh $CLAUDE_PLUGIN_DATA/`):
 *     OBSOLETE. The writer is no longer a separate script — it is `factory
 *     statusline`, a subcommand of the checked-in bundle. The template's
 *     statusLine already points at `${CLAUDE_PLUGIN_ROOT}/bin/factory statusline`,
 *     a stable path under the plugin install. Nothing to copy.
 *   - the asyncRewake CC-version compat probe + hook stripping: the merged
 *     template no longer carries the asyncrewake-ci.sh hook (it referenced a
 *     retired bash script; the real CI watcher work is out of scope here).
 *   - exec bit self-heal on bin/pipeline-*: those scripts are retired.
 *   - the staleness / relaunch-detection state machine: `ensure` always
 *     (re)materializes; relaunch detection is the caller's concern.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import type { ExitCode } from "../../shared/exit-codes.js";
import { EXIT } from "../../shared/exit-codes.js";
import { parseArgs, isUsageError } from "../args.js";
import { emitLine, emitError } from "../io.js";
import { resolveDataDir, resolvePluginRoot } from "../../config/index.js";
import { decideAutonomyPreflight, isAutonomous } from "../../autonomy/mode.js";
import type { PreflightReason } from "../../autonomy/mode.js";
import { atomicWriteFile } from "../../shared/atomic-write.js";
import { stringifyJson } from "../../shared/json.js";
import { createLogger } from "../../shared/logging.js";
import { tildeShorten } from "../../shared/paths.js";
import type { Subcommand } from "../registry-types.js";

const log = createLogger("autonomy");

const HELP = `factory autonomy <ensure|status|preflight> — manage / inspect autonomous mode

The pipeline runs unattended: \`run create\`/\`run resume\` HALT unless the session
is autonomous (FACTORY_AUTONOMOUS_MODE=1). There is no opt-out.

ensure     Merges templates/settings.autonomous.json with your existing settings into
           \${CLAUDE_PLUGIN_DATA}/merged-settings.json (placeholders substituted, env
           baked, statusLine wired to \`factory statusline\`) and prints the relaunch
           command:

             claude --worktree --settings <merged-settings.json>

status     Reports whether THIS session is autonomous and whether merged-settings.json
           exists. Exits 0 when autonomous, 1 when not (never throws).

preflight  The run-entry check (what \`/factory:run\` calls). Decides over
           {autonomous?, merged-settings present?, plugin vs on-disk version} whether
           the run may proceed. (Re)scaffolds merged-settings.json and halts for a
           relaunch when the session is not autonomous OR the settings are stale /
           missing / unstamped; proceeds silently when already fresh (or autonomous via
           a directly-exported env). Exits 0 to proceed, 1 to halt. Never throws on the
           decision path.

Usage:
  factory autonomy ensure
  factory autonomy status [--json]
  factory autonomy preflight

Options:
  --user-settings <path>   (ensure / preflight) Override the user-settings source (default: ~/.claude/settings.json)
  --json                   (status) Emit machine-readable JSON`;

/**
 * The `factory` bundle entrypoint (the PATH shim onto the CLI bundle). The
 * statusLine WRITER the template wires is `<this> statusline`; the ownership check
 * below compares a user statusLine's first token against this path, so deriving it
 * here (not by re-splitting a constructed command string) keeps the two in step.
 */
function factoryBinPath(pluginRoot: string): string {
  return `${pluginRoot}/bin/factory`;
}

/** Path of the materialized merged settings inside the data dir. */
export function mergedSettingsPath(dataDir: string): string {
  return join(dataDir, "merged-settings.json");
}

/** Expand a leading `~` in a user command to the absolute `$HOME` path. */
function tildeExpand(value: string, home: string): string {
  if (value.startsWith("~")) return home + value.slice(1);
  return value;
}

/**
 * Recursively substitute the three plugin placeholders in every string of a
 * JSON value (the `walk()` the old jq did). ORDER MATTERS: `_DATA_TILDE` is
 * replaced before `_DATA` so the longer token is not partially consumed.
 */
export function substitutePlaceholders(
  value: unknown,
  vars: { pluginRoot: string; dataDir: string; dataDirTilde: string },
): unknown {
  if (typeof value === "string") {
    return value
      .split("${CLAUDE_PLUGIN_ROOT}")
      .join(vars.pluginRoot)
      .split("${CLAUDE_PLUGIN_DATA_TILDE}")
      .join(vars.dataDirTilde)
      .split("${CLAUDE_PLUGIN_DATA}")
      .join(vars.dataDir);
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitutePlaceholders(v, vars));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substitutePlaceholders(v, vars);
    }
    return out;
  }
  return value;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read `.statusLine.command` from a settings object, if present and a string. */
function statusLineCommandOf(settings: Record<string, unknown>): string | undefined {
  const sl = settings.statusLine;
  if (!isObject(sl)) return undefined;
  const cmd = sl.command;
  return typeof cmd === "string" && cmd.length > 0 ? cmd : undefined;
}

/** Inputs to {@link materializeMergedSettings}. */
export interface MaterializeInput {
  /** The raw `templates/settings.autonomous.json` text. */
  readonly template: string;
  /** The user's existing settings object (or `{}` when none / unparseable). */
  readonly userSettings: Record<string, unknown>;
  /** Resolved `$CLAUDE_PLUGIN_DATA` (real value). */
  readonly dataDir: string;
  /** Resolved `$CLAUDE_PLUGIN_ROOT` (real value). */
  readonly pluginRoot: string;
  /** `$HOME` for the `~`-shortened DATA_TILDE form + statusline expansion. */
  readonly home: string;
  /** Optional plugin version to stamp as `_factoryVersion`. */
  readonly version?: string;
}

/**
 * Build the merged settings object: user settings as the base, the
 * placeholder-substituted template overlaid (permissions/env/statusLine/hooks),
 * `env.CLAUDE_PLUGIN_DATA` baked, and the user's own statusLine chained via
 * `env.FACTORY_ORIGINAL_STATUSLINE`. Pure — no IO.
 */
export function materializeMergedSettings(input: MaterializeInput): Record<string, unknown> {
  const { dataDir, pluginRoot, home } = input;

  const parsedTemplate: unknown = JSON.parse(input.template);
  if (!isObject(parsedTemplate)) {
    throw new Error("autonomy: settings.autonomous.json is not a JSON object");
  }
  const template = substitutePlaceholders(parsedTemplate, {
    pluginRoot,
    dataDir,
    dataDirTilde: tildeShorten(dataDir, home),
  }) as Record<string, unknown>;

  // User settings is the base; template keys overlay it (template wins on
  // conflicts — autonomous mode's permissions/hooks/statusLine must take effect).
  // NOTE: a top-level `hooks` in the template REPLACES the user's `hooks` (object
  // spread is shallow). That is intentional and NOT a security regression: the
  // factory's enforcement hooks load independently via `hooks/hooks.json` (the
  // plugin's own hook wiring), so the guard boundary holds regardless of what the
  // merged-settings.json carries. The template's `hooks` here only configures the
  // autonomous *session*, not the enforcement layer.
  const merged: Record<string, unknown> = { ...input.userSettings, ...template };

  // env: union user + template, then bake CLAUDE_PLUGIN_DATA. Both user and
  // template envs are preserved (template wins on key conflicts) so the pin and
  // FACTORY_AUTONOMOUS_MODE always survive.
  const userEnv = isObject(input.userSettings.env) ? input.userSettings.env : {};
  const templateEnv = isObject(template.env) ? template.env : {};
  const env: Record<string, unknown> = { ...userEnv, ...templateEnv };
  env.CLAUDE_PLUGIN_DATA = dataDir;

  // permissions.allow: union user + template (deny/other keys: template wins).
  const userPerms = isObject(input.userSettings.permissions) ? input.userSettings.permissions : {};
  const templatePerms = isObject(template.permissions) ? template.permissions : {};
  const userAllow = Array.isArray(userPerms.allow)
    ? userPerms.allow.filter((e): e is string => typeof e === "string")
    : [];
  const templateAllow = Array.isArray(templatePerms.allow)
    ? templatePerms.allow.filter((e): e is string => typeof e === "string")
    : [];
  const unionedAllow = [...userAllow, ...templateAllow.filter((e) => !userAllow.includes(e))];
  merged.permissions = { ...userPerms, ...templatePerms, allow: unionedAllow };

  // statusLine chaining: if the user has their OWN statusLine that is NOT the
  // factory writer, preserve it via FACTORY_ORIGINAL_STATUSLINE (tilde-expanded)
  // so `factory statusline` chains to it. The template's statusLine (the factory
  // writer) always wins as the displayed command.
  const ourPath = factoryBinPath(pluginRoot); // ".../bin/factory"
  const userStatusLine = statusLineCommandOf(input.userSettings);
  // Resolve the user's OWN (non-factory) statusLine to chain, if any.
  const chained = ((): string | undefined => {
    if (userStatusLine === undefined) return undefined;
    const expanded = tildeExpand(userStatusLine, home);
    const parts = expanded.split(/\s+/);
    const expandedPath = parts[0] ?? expanded;
    const expandedSub = parts[1];
    // "Ours" = the factory statusline WRITER specifically: the `.../bin/factory`
    // path with the `statusline` subcommand. TIGHTENED (was a path-only compare,
    // which mis-claimed any `.../bin/factory <other-subcommand>` as ours): a user
    // who wired some OTHER factory subcommand as their statusLine must still be
    // chained — only the writer itself is skipped, to avoid a self-referential loop.
    const isOurs = expandedPath === ourPath && expandedSub === "statusline";
    return isOurs ? undefined : expanded;
  })();
  // Set the chained original, or DROP a stale one. The env block is seeded from the
  // user's own env (`{...userEnv, ...templateEnv}`), so a FACTORY_ORIGINAL_STATUSLINE
  // left over from a PRIOR autonomous relaunch can ride along; when there is nothing
  // legitimate to chain (no user statusLine, or it IS our writer) it must be deleted,
  // else `factory statusline` would chain to a phantom command — or to itself.
  if (chained !== undefined) {
    env.FACTORY_ORIGINAL_STATUSLINE = chained;
  } else {
    delete env.FACTORY_ORIGINAL_STATUSLINE;
  }

  merged.env = env;

  if (input.version !== undefined && input.version.length > 0) {
    merged._factoryVersion = input.version;
  }

  return merged;
}

/** Read the plugin version from `<pluginRoot>/.claude-plugin/plugin.json`. */
async function readPluginVersion(pluginRoot: string): Promise<string | undefined> {
  const path = join(pluginRoot, ".claude-plugin", "plugin.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isObject(parsed) && typeof parsed.version === "string") return parsed.version;
  } catch {
    /* unparseable plugin.json → no version stamp */
  }
  return undefined;
}

/** Options for {@link runAutonomyEnsure}; all paths injectable for tests. */
export interface AutonomyEnsureOptions {
  /** Resolved data dir (defaults to {@link resolveDataDir}). */
  readonly dataDir?: string;
  /** Resolved plugin root (defaults to {@link resolvePluginRoot}). */
  readonly pluginRoot?: string;
  /** User-settings source path (defaults to `~/.claude/settings.json`). */
  readonly userSettingsPath?: string;
  /** `$HOME` (defaults to os.homedir()). */
  readonly home?: string;
  /** stdout sink (defaults to process.stdout). */
  readonly writeStdout?: (text: string) => void;
}

/** Result of {@link runAutonomyEnsure}. */
export interface AutonomyEnsureResult {
  /** Absolute path to the written merged-settings.json. */
  readonly path: string;
  /** The relaunch command printed to stdout. */
  readonly relaunchCommand: string;
}

/**
 * Materialize merged-settings.json on disk and print the relaunch command.
 * Reads the user's settings (missing/unparseable → `{}`), the template, and the
 * plugin version, builds the merged object, and writes it atomically.
 */
export async function runAutonomyEnsure(
  opts: AutonomyEnsureOptions = {},
): Promise<AutonomyEnsureResult> {
  const home = opts.home ?? homedir();
  const dataDir = opts.dataDir ?? resolveDataDir();
  const pluginRoot = opts.pluginRoot ?? resolvePluginRoot();
  const userSettingsPath = opts.userSettingsPath ?? join(home, ".claude", "settings.json");
  const write = opts.writeStdout ?? ((t: string) => process.stdout.write(t));

  // Read user settings (best-effort: missing or unparseable → empty base).
  let userSettings: Record<string, unknown> = {};
  if (existsSync(userSettingsPath)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(userSettingsPath, "utf8"));
      if (isObject(parsed)) userSettings = parsed;
      else log.warn(`${userSettingsPath} is not a JSON object; ignoring`);
    } catch (err) {
      log.warn(`could not parse ${userSettingsPath} (${(err as Error).message}); ignoring`);
    }
  }

  // Read the template from the plugin install.
  const templatePath = join(pluginRoot, "templates", "settings.autonomous.json");
  const template = await readFile(templatePath, "utf8");

  const version = await readPluginVersion(pluginRoot);
  const merged = materializeMergedSettings({
    template,
    userSettings,
    dataDir,
    pluginRoot,
    home,
    version,
  });

  const path = mergedSettingsPath(dataDir);
  await atomicWriteFile(path, stringifyJson(merged));

  const relaunchCommand = `claude --worktree --settings ${path}`;
  write(
    `Wrote autonomous settings → ${path}\n` +
      `Relaunch the session in autonomous mode with:\n\n  ${relaunchCommand}\n\n` +
      `(the first agent turn refreshes the usage cache → session-mode quota pacing.)\n`,
  );

  return { path, relaunchCommand };
}

/** Machine-readable autonomy status (the `--json` payload). */
export interface AutonomyStatus {
  /** The gate predicate: FACTORY_AUTONOMOUS_MODE === "1". */
  readonly autonomous: boolean;
  /** Whether the env var is present at all (distinguishes "unset" from "wrong value"). */
  readonly envSet: boolean;
  /** Whether the merged-settings.json the autonomous relaunch needs exists. */
  readonly mergedSettingsPresent: boolean;
  /** Where that file lives (empty when the data dir can't be resolved). */
  readonly mergedSettingsPath: string;
}

/** Options for {@link runAutonomyStatus}; injectable for tests. */
export interface AutonomyStatusOptions {
  readonly dataDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly json?: boolean;
  readonly writeStdout?: (text: string) => void;
}

/**
 * The CHECK half ported from the old bash `pipeline-ensure-autonomy`: report
 * whether the current session is autonomous and whether the merged settings file
 * exists. Exits 0 when autonomous, 1 when not — and NEVER throws, because this is
 * the diagnostic the user runs precisely WHEN the mandatory gate has halted them.
 */
export async function runAutonomyStatus(opts: AutonomyStatusOptions = {}): Promise<ExitCode> {
  const env = opts.env ?? process.env;
  const write = opts.writeStdout ?? ((t: string) => process.stdout.write(t));

  let path = "";
  try {
    const dataDir = opts.dataDir ?? resolveDataDir();
    path = mergedSettingsPath(dataDir);
  } catch {
    /* data dir unresolvable → report the env signal only (never throw) */
  }
  const status: AutonomyStatus = {
    autonomous: isAutonomous(env),
    envSet: env.FACTORY_AUTONOMOUS_MODE !== undefined,
    mergedSettingsPresent: path.length > 0 && existsSync(path),
    mergedSettingsPath: path,
  };

  if (opts.json === true) {
    write(stringifyJson(status) + "\n");
  } else if (status.autonomous) {
    write(
      `autonomous: yes (FACTORY_AUTONOMOUS_MODE=1)\n` +
        `merged-settings: ${status.mergedSettingsPresent ? "present" : "absent"}` +
        `${path.length > 0 ? ` at ${path}` : ""}\n`,
    );
  } else {
    write(
      `autonomous: NO — the pipeline will refuse to start or resume a run.\n` +
        `merged-settings: ${status.mergedSettingsPresent ? `present at ${path}` : "absent"}\n` +
        (status.mergedSettingsPresent
          ? `Relaunch the session with:\n  claude --worktree --settings ${path}\n`
          : `Run \`factory autonomy ensure\` first, then relaunch with the printed command.\n`),
    );
  }

  return status.autonomous ? EXIT.OK : EXIT.ERROR;
}

/**
 * Read the stamped `_factoryVersion` from an existing merged-settings.json.
 * Missing file / unparseable JSON / unstamped → `undefined` (the decision fn
 * treats an absent stamp as a pre-versioning artifact = stale).
 */
async function readOnDiskVersion(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isObject(parsed) && typeof parsed._factoryVersion === "string") {
      return parsed._factoryVersion;
    }
  } catch {
    /* unparseable merged-settings.json → treat as unstamped (stale) */
  }
  return undefined;
}

/** Human-facing one-liner explaining a preflight verdict (for the printed report). */
function describePreflightReason(
  reason: PreflightReason,
  pluginVersion: string | undefined,
  onDiskVersion: string | undefined,
): string {
  switch (reason) {
    case "fresh":
      return `merged settings are current (v${pluginVersion ?? "?"})`;
    case "ci-raw-env":
      return "autonomous via the environment directly; no merged-settings file needed";
    case "version-unknowable":
      return "plugin version is unreadable — leaving the existing merged settings untouched";
    case "missing-settings":
      return "no merged settings exist yet";
    case "not-autonomous":
      return "this session is not autonomous";
    case "stale-version":
      return `merged settings are stale (v${onDiskVersion ?? "?"} → v${pluginVersion ?? "?"})`;
    case "unstamped":
      return "merged settings predate version stamping (treated as stale)";
  }
}

/** Options for {@link runAutonomyPreflight}; injectable for tests. */
export interface AutonomyPreflightOptions {
  readonly dataDir?: string;
  readonly pluginRoot?: string;
  readonly userSettingsPath?: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly writeStdout?: (text: string) => void;
}

/**
 * The run-entry composer ported from the old `pipeline-ensure-autonomy` step:
 * decide — over {autonomous, merged-settings present, plugin vs on-disk version}
 * via the pure {@link decideAutonomyPreflight} — whether `/factory:run` may
 * proceed, scaffolding (delegating to {@link runAutonomyEnsure}, the single
 * writer path) and halting for the irreducible relaunch when it must.
 *
 * Infallible on the decision path (like `status`): an unresolvable data/root dir
 * degrades to a halt-with-message rather than a throw. A throw can surface only
 * from inside the atomic `ensure` write itself. Returns `EXIT.OK` to proceed,
 * `EXIT.ERROR` to halt.
 */
export async function runAutonomyPreflight(opts: AutonomyPreflightOptions = {}): Promise<ExitCode> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const write = opts.writeStdout ?? ((t: string) => process.stdout.write(t));

  // Resolve paths defensively — never throw while DECIDING (the throw budget
  // belongs to the ensure write, below).
  let dataDir: string | undefined;
  let pluginRoot: string | undefined;
  try {
    dataDir = opts.dataDir ?? resolveDataDir();
  } catch {
    /* unresolvable data dir → handled as a degraded halt below */
  }
  try {
    pluginRoot = opts.pluginRoot ?? resolvePluginRoot();
  } catch {
    /* unresolvable plugin root → handled as a degraded halt below */
  }

  const path = dataDir !== undefined ? mergedSettingsPath(dataDir) : "";
  const mergedSettingsPresent = path.length > 0 && existsSync(path);
  const pluginVersion = pluginRoot !== undefined ? await readPluginVersion(pluginRoot) : undefined;
  const onDiskVersion = mergedSettingsPresent ? await readOnDiskVersion(path) : undefined;

  const decision = decideAutonomyPreflight({
    autonomous: isAutonomous(env),
    mergedSettingsPresent,
    pluginVersion,
    onDiskVersion,
  });
  const verdict = describePreflightReason(decision.reason, pluginVersion, onDiskVersion);

  if (decision.regenerate) {
    // A regenerate always implies halt-for-relaunch (the PreflightDecision
    // invariant). If we cannot resolve where to scaffold, degrade to a message.
    if (dataDir === undefined || pluginRoot === undefined) {
      write(
        `HALT: ${verdict}.\n` +
          `Cannot resolve the plugin data/root dir to scaffold autonomous settings here — ` +
          "run `factory autonomy ensure` once the environment is set, then relaunch with the printed command.\n",
      );
      return EXIT.ERROR;
    }
    await runAutonomyEnsure({
      dataDir,
      pluginRoot,
      userSettingsPath: opts.userSettingsPath,
      home,
      writeStdout: write,
    });
    write(`\nHALT: ${verdict} — relaunch to continue (command above).\n`);
    return EXIT.ERROR;
  }

  // proceed without regenerating (fresh / ci-raw-env / version-unknowable).
  write(`OK: autonomous mode ready — ${verdict}.\n`);
  return EXIT.OK;
}

async function run(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: ["json"] });
  if (args.flag("help") === true) {
    emitLine(HELP);
    return EXIT.OK;
  }

  // Verbs: `ensure` (default) materializes; `status` reports + exits 0/1;
  // `preflight` decides + scaffolds-and-halts when needed (the run-entry call).
  const verb = args.positionals[0];
  if (verb === "status") {
    return runAutonomyStatus({ json: args.flag("json") === true });
  }
  const userSettings = args.flag("user-settings");
  if (verb === "preflight") {
    return runAutonomyPreflight({
      userSettingsPath: typeof userSettings === "string" ? userSettings : undefined,
    });
  }
  if (verb !== undefined && verb !== "ensure") {
    emitError(`autonomy: unknown verb '${verb}' (expected: ensure | status | preflight)`);
    return EXIT.USAGE;
  }

  await runAutonomyEnsure({
    userSettingsPath: typeof userSettings === "string" ? userSettings : undefined,
  });
  return EXIT.OK;
}

export const autonomyCommand: Subcommand = {
  describe: "Materialize merged-settings.json for an autonomous relaunch + print the command",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`autonomy: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
