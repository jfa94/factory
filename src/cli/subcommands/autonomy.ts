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

import type { ExitCode } from "../exit-codes.js";
import { EXIT } from "../exit-codes.js";
import { parseArgs, isUsageError } from "../args.js";
import { emitLine, emitError } from "../io.js";
import { resolveDataDir, resolvePluginRoot } from "../../config/index.js";
import { atomicWriteFile } from "../../shared/atomic-write.js";
import { stringifyJson } from "../../shared/json.js";
import { createLogger } from "../../shared/logging.js";
import type { Subcommand } from "../main.js";

const log = createLogger("autonomy");

const HELP = `factory autonomy ensure — materialize merged-settings.json for an autonomous relaunch

Merges templates/settings.autonomous.json with your existing settings into
\${CLAUDE_PLUGIN_DATA}/merged-settings.json (placeholders substituted, env baked,
statusLine wired to \`factory statusline\`) and prints the relaunch command:

  claude --settings <merged-settings.json>

Usage:
  factory autonomy ensure

Options:
  --user-settings <path>   Override the user-settings source (default: ~/.claude/settings.json)`;

/** The statusLine command the template wires (the bundle's own writer). */
function factoryStatuslineCommand(pluginRoot: string): string {
  return `${pluginRoot}/bin/factory statusline`;
}

/** Path of the materialized merged settings inside the data dir. */
export function mergedSettingsPath(dataDir: string): string {
  return join(dataDir, "merged-settings.json");
}

/** The `~`-shortened form of an absolute path under `$HOME` (else unchanged). */
function tildeShorten(absPath: string, home: string): string {
  if (home.length > 0 && absPath.startsWith(home)) {
    return "~" + absPath.slice(home.length);
  }
  return absPath;
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
  const ourCommand = factoryStatuslineCommand(pluginRoot);
  const ourPath = ourCommand.split(" ")[0] ?? ourCommand; // ".../bin/factory"
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

  const relaunchCommand = `claude --settings ${path}`;
  write(
    `Wrote ${path}\n` +
      `Relaunch the session in autonomous mode with:\n\n  ${relaunchCommand}\n\n` +
      `The first agent turn fires the statusline → a fresh usage-cache.json → session-mode quota pacing.\n`,
  );

  return { path, relaunchCommand };
}

async function run(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv);
  if (args.flag("help") === true) {
    emitLine(HELP);
    return EXIT.OK;
  }

  // Sole verb: `ensure`. Accept it as positional (tolerate a bare `factory
  // autonomy` too — default to ensure).
  const verb = args.positionals[0];
  if (verb !== undefined && verb !== "ensure") {
    emitError(`autonomy: unknown verb '${verb}' (expected: ensure)`);
    return EXIT.USAGE;
  }

  const userSettings = args.flag("user-settings");
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
