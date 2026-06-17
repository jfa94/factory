/**
 * E1 (F-perm) — TARGET-repo `.claude/settings.json` emit + idempotent merge.
 *
 * `factory scaffold` calls {@link ensureTargetSettings} so an interactive
 * `/factory:run` in the scaffolded repo runs the CLI + agents WITHOUT a
 * permission prompt per call. It writes (or non-destructively MERGES into) the
 * target's `.claude/settings.json`:
 *   - unions {@link FACTORY_TARGET_ALLOWLIST} into `permissions.allow`,
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

const log = createLogger("cli:target-settings");

/**
 * The minimal-but-sufficient permission allow-list an interactive factory run
 * needs in the TARGET repo. Each entry maps to a concrete pipeline action:
 *
 *   - `Bash(factory:*)`        — the orchestrator shells `factory next/drive/…`.
 *   - `Bash(git:*)` / `Bash(gh:*)` — preflight `git rev-parse`, reviewer
 *                                 `git -C <wt> diff`, scaffold's `gh repo view`,
 *                                 plus producers' commit/branch plumbing.
 *   - `Bash(npm:*)` / `Bash(npx:*)` — test-writer/task-executor run the project
 *                                 test runner + the GateRunner's npm/npx tools.
 *   - `Read`/`Write`/`Edit`/`Grep`/`Glob`/`Agent` — the agent tools every
 *                                 producer + reviewer (and the orchestrator's
 *                                 Agent() spawns) use.
 *   - `Read|Write|Edit(${CLAUDE_PLUGIN_DATA}/**)` — run/spec state lives OUTSIDE
 *                                 the repo under the data dir; the CLI + agents
 *                                 touch it constantly. The `${CLAUDE_PLUGIN_DATA}`
 *                                 placeholder is expanded by Claude Code at load
 *                                 time, so it stays portable across installs.
 */
export const FACTORY_TARGET_ALLOWLIST: readonly string[] = [
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
  "Read(${CLAUDE_PLUGIN_DATA}/**)",
  "Write(${CLAUDE_PLUGIN_DATA}/**)",
  "Edit(${CLAUDE_PLUGIN_DATA}/**)",
];

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
 * Union {@link FACTORY_TARGET_ALLOWLIST} into `existing.permissions.allow` and
 * force `worktree.baseRef:"head"`, preserving every other key. Pure: clones the
 * input and never mutates it. `changed` is false iff the result is byte-equal in
 * the keys we own (allow-list fully present + baseRef already "head").
 */
export function mergeTargetSettings(existing: Record<string, unknown>): MergeResult {
  // Structured clone so the caller's object is never mutated (test isolation +
  // safe re-merge of an already-merged object).
  const settings: Record<string, unknown> = structuredClone(existing);
  let changed = false;

  // permissions.allow — union, preserving order: user entries first, then any
  // missing factory entries appended (dedup keeps re-merge a no-op).
  const permissions = isObject(settings.permissions) ? settings.permissions : {};
  const currentAllow = Array.isArray(permissions.allow)
    ? permissions.allow.filter((e): e is string => typeof e === "string")
    : [];
  const have = new Set(currentAllow);
  const additions = FACTORY_TARGET_ALLOWLIST.filter((e) => !have.has(e));
  if (additions.length > 0) {
    permissions.allow = [...currentAllow, ...additions];
    settings.permissions = permissions;
    changed = true;
  }

  // worktree.baseRef: "head" — the staging-determinism invariant. Bind the
  // (possibly fresh) worktree object once, then force baseRef. Assigning the same
  // reference when it already existed is a no-op; flipping baseRef is the only
  // change-bearing mutation.
  const worktree = isObject(settings.worktree) ? settings.worktree : {};
  settings.worktree = worktree;
  if (worktree.baseRef !== "head") {
    worktree.baseRef = "head";
    changed = true;
  }

  return { settings, changed };
}

/**
 * Read the target repo's `.claude/settings.json` (if any), merge the factory
 * allow-list + worktree.baseRef into it, and write it back atomically. Creates
 * `.claude/` as needed. Idempotent: a second call reports `changed:false` and
 * rewrites nothing.
 *
 * @param opts.targetRoot The target repo working tree.
 */
export async function ensureTargetSettings(opts: {
  readonly targetRoot: string;
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

  const { settings, changed } = mergeTargetSettings(existing);

  // Write when creating OR when the merge altered something. A no-op merge of an
  // existing file leaves the file byte-for-byte untouched (idempotent on disk).
  if (created || changed) {
    await mkdir(dir, { recursive: true });
    await atomicWriteFile(path, stringifyJson(settings));
  }

  return { settings, changed, created, path };
}
