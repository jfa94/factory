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
/* eslint-disable security/detect-non-literal-fs-filename -- fs seam: paths are internal derived run/spec/state/repo paths, never external input; runtime write-danger is covered by the TCB write-deny hook */
import {mkdir, readFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {join} from 'node:path'

import {atomicWriteFile} from '../../shared/atomic-write.js'
import {stringifyJson} from '../../shared/json.js'
import {createLogger} from '../../shared/logging.js'
import {tildeShorten} from '../../shared/paths.js'

const log = createLogger('cli:target-settings')

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
    'Bash(factory:*)',
    'Bash(git:*)',
    'Bash(gh:*)',
    'Bash(npm:*)',
    'Bash(npx:*)',
    'Read',
    'Write',
    'Edit',
    'Grep',
    'Glob',
    'Agent',
]

/** The verbs scoped to the data dir in the baked `Read|Write|Edit(<dir>/**)` rules. */
const DATA_DIR_VERBS = ['Read', 'Write', 'Edit'] as const

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
    readonly allowGlobBase: string
    /**
     * The `permissions.additionalDirectories` value — ALWAYS the absolute path.
     * Claude Code does not expand `~/` in `additionalDirectories` (verified live:
     * the tilde form left the working-directory-boundary prompt firing on task
     * worktree writes, run-20260630-095544), so this entry trades the `$HOME`
     * leak for a rule that actually matches.
     */
    readonly additionalDir: string
}

/**
 * Build the {@link TargetDataDirRules} for a CLI-resolved data dir. The allow
 * globs prefer the `~`-tilde form (documented to expand; keeps a committed target
 * `.claude/settings.json` free of `$HOME`), falling back to the absolute path when
 * the data dir is outside `$HOME` (e.g. a custom `CLAUDE_PLUGIN_DATA`).
 * `additionalDir` is ALWAYS absolute — see {@link TargetDataDirRules.additionalDir}.
 */
export function buildTargetDataDirRules(opts: {
    /** The absolute, canonical data dir (from `resolveDataDir()`). */
    readonly dataDir: string
    /** `$HOME`, for the tilde shortening. */
    readonly home: string
}): TargetDataDirRules {
    return {
        allowGlobBase: tildeShorten(opts.dataDir, opts.home),
        additionalDir: opts.dataDir,
    }
}

/** The three baked `Read|Write|Edit(<base>/**)` allow rules for a resolved dir. */
function dataDirAllowRules(allowGlobBase: string): string[] {
    return DATA_DIR_VERBS.map((verb) => `${verb}(${allowGlobBase}/**)`)
}

/** Result of an idempotent {@link mergeTargetSettings}. */
export interface MergeResult {
    /** The merged settings object (a NEW object; the input is not mutated). */
    readonly settings: Record<string, unknown>
    /** Whether the merge actually altered anything (false ⇒ already complete). */
    readonly changed: boolean
}

/** Result of {@link ensureTargetSettings} (the on-disk wrapper). */
export interface EnsureResult extends MergeResult {
    /** Absolute path to the written `.claude/settings.json`. */
    readonly path: string
    /** Whether the file did not exist before (a fresh emit vs. a merge). */
    readonly created: boolean
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Union the factory permission rules into `existing` and force
 * `worktree.baseRef:"head"`, preserving every other key. Pure: clones the input
 * and never mutates it.
 *
 * For both `permissions.allow` and `permissions.additionalDirectories` the merge
 * UNIONS the target entries ({@link FACTORY_TARGET_BASE_ALLOWLIST} + the baked
 * data-dir rules from `dataDirRules`), order-preserving, deduped. `changed` is
 * additions-only. Idempotent: re-merging an already-baked settings reports
 * `changed:false`.
 */
export function mergeTargetSettings(existing: Record<string, unknown>, dataDirRules: TargetDataDirRules): MergeResult {
    // Structured clone so the caller's object is never mutated (test isolation +
    // safe re-merge of an already-merged object).
    const settings: Record<string, unknown> = structuredClone(existing)
    let changed = false

    // permissions.allow — union the base allow-list + the baked data-dir rules.
    // User entries kept first.
    const permissions = isObject(settings.permissions) ? settings.permissions : {}
    const currentAllow = Array.isArray(permissions.allow)
        ? permissions.allow.filter((e): e is string => typeof e === 'string')
        : []
    const targetAllow = [...FACTORY_TARGET_BASE_ALLOWLIST, ...dataDirAllowRules(dataDirRules.allowGlobBase)]
    const have = new Set(currentAllow)
    const additions = targetAllow.filter((e) => !have.has(e))
    if (additions.length > 0) {
        permissions.allow = [...currentAllow, ...additions]
        settings.permissions = permissions
        changed = true
    }

    // permissions.additionalDirectories — same union so the built-in file tools
    // never trip the working-directory boundary on out-of-tree data-dir writes
    // (`results/<run>`, `worktrees/<run>/<task>`). The single baked parent entry
    // grants recursive access to every managed subdir.
    const currentDirs = Array.isArray(permissions.additionalDirectories)
        ? permissions.additionalDirectories.filter((e): e is string => typeof e === 'string')
        : []
    const haveDirs = new Set(currentDirs)
    const dirAdditions = [dataDirRules.additionalDir].filter((e) => !haveDirs.has(e))
    if (dirAdditions.length > 0) {
        permissions.additionalDirectories = [...currentDirs, ...dirAdditions]
        settings.permissions = permissions
        changed = true
    }

    // worktree.baseRef: "head" — the staging-determinism invariant. Only mutate when
    // baseRef is not already "head": bind the (possibly fresh) worktree object AND
    // flip baseRef together inside the change branch, so an existing `{baseRef:"head"}`
    // is a true no-op (no redundant self-assignment).
    const worktree = isObject(settings.worktree) ? settings.worktree : {}
    if (worktree.baseRef !== 'head') {
        worktree.baseRef = 'head'
        settings.worktree = worktree
        changed = true
    }

    return {settings, changed}
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
    readonly targetRoot: string
    readonly dataDirRules: TargetDataDirRules
}): Promise<EnsureResult> {
    const dir = join(opts.targetRoot, '.claude')
    const path = join(dir, 'settings.json')
    const created = !existsSync(path)

    let existing: Record<string, unknown> = {}
    if (!created) {
        const raw = await readFile(path, 'utf8')
        const parsed: unknown = raw.trim().length > 0 ? JSON.parse(raw) : {}
        if (isObject(parsed)) {
            existing = parsed
        } else {
            // Valid JSON but not an object (array / number / string). We're about to
            // write a merged settings object, which REPLACES this file — warn loudly so
            // the destructive overwrite is visible (the non-JSON case already throws via
            // JSON.parse above; this is the silently-coerced gap).
            log.warn(
                `${path} is valid JSON but not an object (${
                    Array.isArray(parsed) ? 'array' : typeof parsed
                }); replacing it with the factory settings object`
            )
        }
    }

    const {settings, changed} = mergeTargetSettings(existing, opts.dataDirRules)

    // Write when creating OR when the merge altered something. A no-op merge of an
    // existing file leaves the file byte-for-byte untouched (idempotent on disk).
    if (created || changed) {
        await mkdir(dir, {recursive: true})
        await atomicWriteFile(path, stringifyJson(settings))
    }

    return {settings, changed, created, path}
}
