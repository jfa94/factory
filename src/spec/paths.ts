/**
 * Spec-store path layout. The durable spec store lives OUTSIDE the target repo at
 * `<dataDir>/specs/<repo-key>/<spec-id>/` (keyed by (repo, spec-id), reused across
 * runs); the in-repo reviewable mirror is `docs/factory/<spec-id>`; transient
 * spec-build scratch is rooted at the repo's `.claude/worktrees/` ({@link defaultSpecBuildRoot}).
 */
import {join} from 'node:path'
import {validateId} from '../shared/ids.js'

/** Subdir name for the durable spec store. */
export const SPECS_DIR = 'specs'
/** Subdir name for the TRANSIENT spec-build scratch area. */
export const SPEC_BUILD_DIR = 'spec-build'
/** Subdir under a target repo's `docs/` for the in-repo reviewable spec copy. */
export const DOCS_FACTORY_DIR = 'factory'

/**
 * Sanitize a repo id (e.g. "owner/name") into a single safe path segment.
 * Records `/` and any char outside [a-zA-Z0-9._-] to '-', collapses runs, trims.
 * Keeps case and dots for addressability and does not truncate.
 */
export function repoKey(repo: string): string {
    const key = repo
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '')
    if (key.length === 0) {
        throw new Error(`repoKey: repo '${repo}' has no usable characters`)
    }
    // A PURE-dot segment is a path-traversal escape out of the spec store.
    if (/^\.+$/.test(key)) {
        throw new Error(`repoKey: repo '${repo}' resolves to a path-traversal segment '${key}'`)
    }
    return key
}

/** `<dataDir>/specs`. */
export function specsRoot(dataDir: string): string {
    return join(dataDir, SPECS_DIR)
}

/** `<dataDir>/specs/<repo-key>/<spec-id>` — the durable per-spec dir. `spec-id` charset is validated. */
export function specDir(dataDir: string, repo: string, specId: string): string {
    validateId(specId, 'spec-id')
    return join(specsRoot(dataDir), repoKey(repo), specId)
}

/**
 * `<docsRoot>/factory/<spec-id>` — the IN-REPO reviewable spec copy. `docsRoot` is
 * the target repo's `docs/` dir, so there is no repo-key segment. The canonical
 * read path stays {@link specDir}.
 */
export function docsFactoryDir(docsRoot: string, specId: string): string {
    validateId(specId, 'spec-id')
    return join(docsRoot, DOCS_FACTORY_DIR, specId)
}

/**
 * The production root for {@link specBuildDir}: `<repoRoot>/.claude/worktrees`.
 * Agents Write their results here; Claude Code exempts `.claude/worktrees/` from
 * protected-path prompts, whereas the OS temp dir sits outside the session (Decision 77).
 */
export function defaultSpecBuildRoot(repoRoot: string): string {
    return join(repoRoot, '.claude', 'worktrees')
}

/** `<root>/spec-build`. */
export function specBuildRoot(root: string): string {
    return join(root, SPEC_BUILD_DIR)
}

/**
 * `<root>/spec-build/<repo-key>/<issue>` — the TRANSIENT, discardable scratch dir
 * for one generate/review loop, keyed by the PRD issue number.
 */
export function specBuildDir(root: string, repo: string, issueNumber: number): string {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new Error(`specBuildDir: issue number must be a positive integer, got ${issueNumber}`)
    }
    return join(specBuildRoot(root), repoKey(repo), String(issueNumber))
}
