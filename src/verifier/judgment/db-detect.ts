/**
 * Decision 51 — content-conditional DB-design review trigger.
 *
 * `touchesDatabase` answers ONE question from ground truth: does the task diff
 * touch relational-schema files (migrations, SQL, ORM schema)? The answer decides
 * whether the `database-design-reviewer` specialist is appended to the panel
 * (panel.ts `panelRolesFor`). Derive-don't-store: both the spawn site
 * (handlers.ts verify) and the record site (record.ts roster enforcement)
 * re-derive it from the same worktree tip, so the two necessarily agree — no
 * persisted roster decision exists to drift.
 *
 * Built-in patterns only, no config surface (YAGNI): the mainstream layouts.
 * `*.sql` deliberately over-matches (seeds/queries) — the specialist's charter
 * approves non-schema SQL rather than the engine guessing intent here.
 */
import type {GitProbe, ToolRunOpts} from '../deterministic/tools.js'

/**
 * Path patterns that mark a changed file as database-touching. Matched against
 * the repo-relative paths from `git diff --name-only` (forward slashes).
 */
export const DB_PATH_PATTERNS: readonly RegExp[] = [
    /(^|\/)migrations\//, // generic + supabase/migrations, django, alembic-as-migrations
    /(^|\/)db\/migrate\//, // rails
    /(^|\/)alembic\/versions\//, // alembic default layout
    /(^|\/)drizzle\//, // drizzle-kit output
    /(^|\/)schema\.prisma$/, // prisma
    /\.sql$/i, // bare SQL anywhere
]

/** True iff one repo-relative path matches a DB pattern. */
export function isDbPath(path: string): boolean {
    return DB_PATH_PATTERNS.some((p) => p.test(path))
}

/**
 * True iff the diff `base...HEAD` in the worktree touches any DB path.
 * Loud on git failure (probe throws) — fail-closed detection is worse than a
 * loud stop, since a silent `false` would skip the specialist on a real schema
 * change.
 */
export async function touchesDatabase(git: GitProbe, baseRef: string, opts: ToolRunOpts): Promise<boolean> {
    const changed = await git.changedFiles(baseRef, opts)
    return changed.some(isDbPath)
}
