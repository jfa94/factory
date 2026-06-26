/**
 * E1 (F-perm) — TARGET-repo `.claude/settings.json` emit + idempotent merge.
 *
 * `factory scaffold` calls {@link ensureTargetSettings} so an interactive
 * `/factory:run` in the scaffolded repo runs the CLI + agents WITHOUT a
 * permission prompt per call. It writes (or non-destructively MERGES into) the
 * target's `.claude/settings.json`:
 *   - unions {@link FACTORY_TARGET_BASE_ALLOWLIST} + the baked data-dir rules
 *     (from {@link buildTargetDataDirRules}) into `permissions.allow`,
 *   - forces `worktree.baseRef: "head"` (the staging-determinism invariant —
 *     CLAUDE.md "Worktree base invariant", Decision 12),
 * and leaves every other user key — including the user's OWN `statusLine` —
 * untouched.
 *
 * Why NO statusLine here (deliberate trade-off): the target repo's
 * `.claude/settings.json` is the user's interactive settings for that repo.
 * Injecting `statusLine` would clobber their own statusline. The factory
 * statusline (usage-cache pacing) belongs ONLY in the separate E2
 * merged-settings.json relaunch (`factory autonomy ensure`), never here.
 *
 * Why this allow-list and not autonomous-mode's coarse `Bash(*)`: this is an
 * INTERACTIVE session with a human present (Decision 17 "Scope"). We grant the
 * concrete command families the pipeline genuinely invokes — the `factory` CLI,
 * git/gh plumbing, the agent tools, and the data-dir reads/writes — and nothing
 * wider. The autonomous-mode deny-list / `Bash(*)` is intentionally NOT mirrored
 * here; a human approves anything the pipeline didn't anticipate.
 */
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFile } from "../../shared/atomic-write.js";
import { stringifyJson } from "../../shared/json.js";
import { createLogger } from "../../shared/logging.js";
import { tildeShorten } from "../../shared/paths.js";

const log = createLogger("cli:target-settings");

/**
 * The data-dir-INDEPENDENT half of the permission allow-list an interactive
 * factory run needs in the TARGET repo. Each entry maps to a concrete pipeline
 * action:
 *
 *   - `Bash(factory:*)`        — the runner shells `factory next-task/next-action/…`.
 *   - `Bash(git:*)` / `Bash(gh:*)` — preflight `git rev-parse`, reviewer
 *                                 `git -C <wt> diff`, scaffold's `gh repo view`,
 *                                 plus producers' commit/branch plumbing.
 *   - `Bash(npm:*)` / `Bash(npx:*)` — test-writer/implementer run the project
 *                                 test runner + the GateRunner's npm/npx tools.
 *   - `Read`/`Write`/`Edit`/`Grep`/`Glob`/`Agent` — the agent tools every
 *                                 producer + reviewer (and the runner's
 *                                 Agent() spawns) use.
 *
 * The data-dir-SCOPED rules (`Read|Write|Edit(<data-dir>/**)`) are NOT here —
 * they are baked per-install from the CLI-resolved data dir by
 * {@link buildTargetDataDirRules} (see below for why).
 */
export const FACTORY_TARGET_BASE_ALLOWLIST: readonly string[] = [
  "Bash(factory:*)",
  "Bash(git:*)",
  "Bash(gh:*)",
  "Bash(npm:*)",
  "Bash(npx:*)",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "Agent",
];

/** The verbs scoped to the data dir in the baked `Read|Write|Edit(<dir>/**)` rules. */
const DATA_DIR_VERBS = ["Read", "Write", "Edit"] as const;

/**
 * STALE allow entries the OLD emitter wrote: the literal `${CLAUDE_PLUGIN_DATA}`
 * placeholder form. We migrate these away (strip on re-merge) because the
 * placeholder does NOT work: env-var interpolation inside permission rules is
 * undocumented in Claude Code, AND `CLAUDE_PLUGIN_DATA` is session-globally
 * corruptible by other plugins (the Codex plugin's SessionStart hook re-exports
 * its OWN data dir into `$CLAUDE_ENV_FILE`), so the rule resolves to the wrong
 * dir or stays literal — never matching factory's data dir. Matched EXACTLY (not
 * via a `.includes("${CLAUDE_PLUGIN_DATA}")` heuristic) so a user rule that
 * legitimately references the var is never clobbered.
 */
const STALE_DATA_DIR_ALLOW: readonly string[] = [
  "Read(${CLAUDE_PLUGIN_DATA}/**)",
  "Write(${CLAUDE_PLUGIN_DATA}/**)",
  "Edit(${CLAUDE_PLUGIN_DATA}/**)",
];

/** The stale literal-placeholder `additionalDirectories` entry (see {@link STALE_DATA_DIR_ALLOW}). */
const STALE_DATA_DIR_ADDITIONAL = "${CLAUDE_PLUGIN_DATA}";

/**
 * The baked, per-install data-dir permission strings. Built from the CLI-resolved
 * canonical data dir (which already CORRECTS the foreign-plugin env-var leak via
 * `resolveDataDir`), NOT from the runtime `${CLAUDE_PLUGIN_DATA}` placeholder — so
 * the rules keep matching even when another plugin has hijacked the env var.
 */
export interface TargetDataDirRules {
  /**
   * Base path for the `Read|Write|Edit(<base>/**)` allow globs. The `~`-tilde
   * form when the data dir is under `$HOME` (git-safe in a committed
   * `.claude/settings.json` — no username leaked; Claude Code expands `~/` in
   * Read/Write/Edit globs), else the absolute path.
   */
  readonly allowGlobBase: string;
  /** The `permissions.additionalDirectories` value (same tilde-or-absolute form). */
  readonly additionalDir: string;
}

/**
 * Build the {@link TargetDataDirRules} for a CLI-resolved data dir. Prefers the
 * `~`-tilde form so a committed target `.claude/settings.json` stays portable and
 * leaks no `$HOME`; falls back to the absolute path when the data dir is outside
 * `$HOME` (e.g. a custom `CLAUDE_PLUGIN_DATA`).
 *
 * NOTE: `~/` in `additionalDirectories` is undocumented in Claude Code (it IS
 * documented for Read/Write/Edit globs). This is the single switch point — if the
 * working-directory-boundary prompt persists for the additional dir, change ONLY
 * `additionalDir` to the absolute form (`opts.dataDir`).
 */
export function buildTargetDataDirRules(opts: {
  /** The absolute, canonical data dir (from `resolveDataDir()`). */
  readonly dataDir: string;
  /** `$HOME`, for the tilde shortening. */
  readonly home: string;
}): TargetDataDirRules {
  const baked = tildeShorten(opts.dataDir, opts.home);
  return { allowGlobBase: baked, additionalDir: baked };
}

/** The three baked `Read|Write|Edit(<base>/**)` allow rules for a resolved dir. */
function dataDirAllowRules(allowGlobBase: string): string[] {
  return DATA_DIR_VERBS.map((verb) => `${verb}(${allowGlobBase}/**)`);
}

/** Result of an idempotent {@link mergeTargetSettings}. */
export interface MergeResult {
  /** The merged settings object (a NEW object; the input is not mutated). */
  readonly settings: Record<string, unknown>;
  /** Whether the merge actually altered anything (false ⇒ already complete). */
  readonly changed: boolean;
}

/** Result of {@link ensureTargetSettings} (the on-disk wrapper). */
export interface EnsureResult extends MergeResult {
  /** Absolute path to the written `.claude/settings.json`. */
  readonly path: string;
  /** Whether the file did not exist before (a fresh emit vs. a merge). */
  readonly created: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Migrate-and-union the factory permission rules into `existing` and force
 * `worktree.baseRef:"head"`, preserving every other key. Pure: clones the input
 * and never mutates it.
 *
 * For both `permissions.allow` and `permissions.additionalDirectories` the merge:
 *   1. STRIPS the stale literal-`${CLAUDE_PLUGIN_DATA}` entries the old emitter
 *      wrote (exact-string match — see {@link STALE_DATA_DIR_ALLOW}), and
 *   2. UNIONS the target entries ({@link FACTORY_TARGET_BASE_ALLOWLIST} + the
 *      baked data-dir rules from `dataDirRules`), order-preserving, deduped.
 *
 * `changed` is driven off `removedStale || additions.length > 0` so a repo that
 * still carries the stale placeholder is rewritten even when the baked rules are
 * already present. Idempotent: re-merging an already-baked, stale-free settings
 * reports `changed:false`.
 */
export function mergeTargetSettings(
  existing: Record<string, unknown>,
  dataDirRules: TargetDataDirRules,
): MergeResult {
  // Structured clone so the caller's object is never mutated (test isolation +
  // safe re-merge of an already-merged object).
  const settings: Record<string, unknown> = structuredClone(existing);
  let changed = false;

  // permissions.allow — strip the stale placeholder rules (migration), then union
  // the base allow-list + the baked data-dir rules. User entries kept first.
  const permissions = isObject(settings.permissions) ? settings.permissions : {};
  const currentAllow = Array.isArray(permissions.allow)
    ? permissions.allow.filter((e): e is string => typeof e === "string")
    : [];
  const strippedAllow = currentAllow.filter((e) => !STALE_DATA_DIR_ALLOW.includes(e));
  const removedStaleAllow = strippedAllow.length !== currentAllow.length;
  const targetAllow = [
    ...FACTORY_TARGET_BASE_ALLOWLIST,
    ...dataDirAllowRules(dataDirRules.allowGlobBase),
  ];
  const have = new Set(strippedAllow);
  const additions = targetAllow.filter((e) => !have.has(e));
  if (removedStaleAllow || additions.length > 0) {
    permissions.allow = [...strippedAllow, ...additions];
    settings.permissions = permissions;
    changed = true;
  }

  // permissions.additionalDirectories — same strip-then-union so the built-in file
  // tools never trip the working-directory boundary on out-of-tree data-dir writes
  // (`results/<run>`, `worktrees/<run>/<task>`). The single baked parent entry
  // grants recursive access to every managed subdir.
  const currentDirs = Array.isArray(permissions.additionalDirectories)
    ? permissions.additionalDirectories.filter((e): e is string => typeof e === "string")
    : [];
  const strippedDirs = currentDirs.filter((e) => e !== STALE_DATA_DIR_ADDITIONAL);
  const removedStaleDir = strippedDirs.length !== currentDirs.length;
  const haveDirs = new Set(strippedDirs);
  const dirAdditions = [dataDirRules.additionalDir].filter((e) => !haveDirs.has(e));
  if (removedStaleDir || dirAdditions.length > 0) {
    permissions.additionalDirectories = [...strippedDirs, ...dirAdditions];
    settings.permissions = permissions;
    changed = true;
  }

  // worktree.baseRef: "head" — the staging-determinism invariant. Only mutate when
  // baseRef is not already "head": bind the (possibly fresh) worktree object AND
  // flip baseRef together inside the change branch, so an existing `{baseRef:"head"}`
  // is a true no-op (no redundant self-assignment).
  const worktree = isObject(settings.worktree) ? settings.worktree : {};
  if (worktree.baseRef !== "head") {
    worktree.baseRef = "head";
    settings.worktree = worktree;
    changed = true;
  }

  return { settings, changed };
}

/**
 * Read the target repo's `.claude/settings.json` (if any), merge the factory
 * allow-list + the baked data-dir rules + worktree.baseRef into it, and write it
 * back atomically. Creates `.claude/` as needed. Idempotent: a second call
 * reports `changed:false` and rewrites nothing.
 *
 * @param opts.targetRoot   The target repo working tree.
 * @param opts.dataDirRules The baked, CLI-resolved data-dir permission rules
 *   (from {@link buildTargetDataDirRules}). REQUIRED — there is no placeholder
 *   fallback by design, so a misresolved dir fails loud instead of silently
 *   re-emitting the broken `${CLAUDE_PLUGIN_DATA}` rule.
 */
export async function ensureTargetSettings(opts: {
  readonly targetRoot: string;
  readonly dataDirRules: TargetDataDirRules;
}): Promise<EnsureResult> {
  const dir = join(opts.targetRoot, ".claude");
  const path = join(dir, "settings.json");
  const created = !existsSync(path);

  let existing: Record<string, unknown> = {};
  if (!created) {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = raw.trim().length > 0 ? JSON.parse(raw) : {};
    if (isObject(parsed)) {
      existing = parsed;
    } else {
      // Valid JSON but not an object (array / number / string). We're about to
      // write a merged settings object, which REPLACES this file — warn loudly so
      // the destructive overwrite is visible (the non-JSON case already throws via
      // JSON.parse above; this is the silently-coerced gap).
      log.warn(
        `${path} is valid JSON but not an object (${
          Array.isArray(parsed) ? "array" : typeof parsed
        }); replacing it with the factory settings object`,
      );
    }
  }

  const { settings, changed } = mergeTargetSettings(existing, opts.dataDirRules);

  // Write when creating OR when the merge altered something. A no-op merge of an
  // existing file leaves the file byte-for-byte untouched (idempotent on disk).
  if (created || changed) {
    await mkdir(dir, { recursive: true });
    await atomicWriteFile(path, stringifyJson(settings));
  }

  return { settings, changed, created, path };
}
