/**
 * Decision 51 — content-conditional DB-design review trigger.
 *
 * `isDbPath` answers ONE question from ground truth: is a changed file a
 * relational-schema file (migrations, SQL, ORM schema)? The feature runtime uses it
 * to decide whether the `database-design-reviewer` specialist joins the panel.
 *
 * Built-in patterns only, no config surface (YAGNI): the mainstream layouts.
 * `*.sql` deliberately over-matches (seeds/queries) — the specialist's charter
 * approves non-schema SQL rather than the engine guessing intent here.
 */

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
