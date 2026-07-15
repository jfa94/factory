/**
 * WS1 — the two-store filesystem layout (plan §"State storage model").
 *
 * All DURABLE run/spec state lives OUTSIDE the target repo, under the plugin data
 * dir (`resolveDataDir()` from src/config). This is a hard requirement: the holdout
 * answer-key must be unreadable from an implementer worktree (Decision 5 / Δ Y), so
 * state cannot live in-repo.
 *
 * Two durable stores:
 *   - DURABLE spec store:  <dataDir>/specs/<repo-key>/<spec-id>/   (Δ X)
 *       Reused across runs; keyed by (repo, spec-id), NOT by run id.
 *   - EPHEMERAL run store: <dataDir>/runs/<run-id>/                 (per run)
 *       state.json + audit.jsonl + metrics.jsonl + holdouts/ + reviews/.
 *
 * A THIRD, non-durable area — the spec-build scratch dir ({@link specBuildDir}) —
 * is NOT part of this dataDir-rooted layout: it holds only transient, pre-validation
 * agent output threaded between subprocess invocations, so it is rooted at the OS
 * temp dir instead ({@link defaultSpecBuildRoot}) and never needs to survive past
 * one generate/review loop.
 *
 * `<repo-key>` is a sanitized path segment derived from a "owner/name" repo id
 * (the slash and any unsafe char recorded to '-') so the spec store is one flat,
 * inspectable directory level per repo.
 */
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {validateId} from '../../shared/ids.js'

/** Subdir name for the durable spec store. */
export const SPECS_DIR = 'specs'
/** Subdir name for the TRANSIENT spec-build scratch area. */
export const SPEC_BUILD_DIR = 'spec-build'
/**
 * Subdir under a target repo's `docs/` for the IN-REPO reviewable spec copy
 * (F-specloc). The durable spec's canonical home stays the out-of-repo dataDir
 * store ({@link specDir}); this is the versioned, PR-reviewable MIRROR written
 * alongside it. It is implementer-immutable — the TCB write-deny protects
 * `docs/factory/**` exactly as it does `.github/workflows/**`.
 */
export const DOCS_FACTORY_DIR = 'factory'
/** Subdir name for the ephemeral run store. */
export const RUNS_DIR = 'runs'
/**
 * RETIRED global `runs/current` symlink name (Decision 61) — no consumer reads it.
 * Kept only so `pointCurrentAt` can best-effort rm a leftover from an older engine.
 */
export const CURRENT_LINK = 'current'
/**
 * Subdir name for the PER-REPO current pointers (run-isolation L2.7). A pointer
 * lives at `<dataDir>/current/<repo-key>` → `../runs/<run-id>`, in a tree SEPARATE
 * from `runs/` so {@link runsRoot} enumeration ({@link runDir} scan) is untouched
 * (a sibling dir, never a child of `runs/`). This is THE authoritative pointer the
 * human CLI resolves per checkout — the sole live current pointer.
 */
export const CURRENT_DIR = 'current'
/** The per-run state file name. */
export const STATE_FILE = 'state.json'
/** The per-run append-only metrics log (WS12 telemetry sink). */
export const METRICS_FILE = 'metrics.jsonl'
/** The per-run append-only audit log (WS12). */
export const AUDIT_FILE = 'audit.jsonl'
/** The per-run persisted partial/finalize report (WS12). */
export const REPORT_FILE = 'report.md'

/**
 * Sanitize a repo id (e.g. "owner/name") into a single safe path segment.
 * Records `/` and any char outside [a-zA-Z0-9._-] to '-', collapses runs, trims.
 * Distinct from `slugify` (which lowercases + caps at 50 and is for human slugs):
 * a repo key must be reversible-ish and case-preserving for addressability, so it
 * keeps case and dots and does not truncate.
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
    // Dots are kept for addressability (e.g. "My.Repo"), but a PURE-dot segment is
    // a path-traversal escape: `repoKey("..")` would yield ".." and let specDir()
    // climb out of the spec store. validateId already rejects this for run-id and
    // spec-id; repo is the one segment that bypasses it, so reject it loudly here.
    if (/^\.+$/.test(key)) {
        throw new Error(`repoKey: repo '${repo}' resolves to a path-traversal segment '${key}'`)
    }
    return key
}

/** `<dataDir>/runs`. */
export function runsRoot(dataDir: string): string {
    return join(dataDir, RUNS_DIR)
}

/** `<dataDir>/runs/<run-id>`. Validates run-id charset. */
export function runDir(dataDir: string, runId: string): string {
    validateId(runId, 'run-id')
    return join(runsRoot(dataDir), runId)
}

/** `<dataDir>/runs/<run-id>/state.json`. */
export function runStatePath(dataDir: string, runId: string): string {
    return join(runDir(dataDir, runId), STATE_FILE)
}

/** `<dataDir>/runs/<run-id>/metrics.jsonl` — the append-only telemetry sink (WS12). */
export function runMetricsPath(dataDir: string, runId: string): string {
    return join(runDir(dataDir, runId), METRICS_FILE)
}

/** `<dataDir>/runs/<run-id>/audit.jsonl` — the append-only audit log (WS12). */
export function runAuditPath(dataDir: string, runId: string): string {
    return join(runDir(dataDir, runId), AUDIT_FILE)
}

/** `<dataDir>/runs/<run-id>/report.md` — the persisted finalize/partial report (WS12). */
export function runReportPath(dataDir: string, runId: string): string {
    return join(runDir(dataDir, runId), REPORT_FILE)
}

/** `<dataDir>/runs/<run-id>/coverage` — the per-tree-SHA coverage summary store (S8). */
export function runCoverageDir(dataDir: string, runId: string): string {
    return join(runDir(dataDir, runId), 'coverage')
}

/** `<dataDir>/current` — the per-repo pointer tree (sibling of `runs/`, L2.7). */
export function currentRepoRoot(dataDir: string): string {
    return join(dataDir, CURRENT_DIR)
}

/**
 * `<dataDir>/current/<repo-key>` — the PER-REPO current pointer (L2.7). The repo id
 * ("owner/name") is recorded to one safe segment via {@link repoKey} (which rejects a
 * pure-dot traversal segment), so a hostile repo id cannot escape the pointer tree.
 */
export function currentRepoLinkPath(dataDir: string, repo: string): string {
    return join(currentRepoRoot(dataDir), repoKey(repo))
}

/** `<dataDir>/specs`. */
export function specsRoot(dataDir: string): string {
    return join(dataDir, SPECS_DIR)
}

/**
 * `<dataDir>/specs/<repo-key>/<spec-id>` — the durable per-spec dir (Δ X).
 * Keyed by (repo, spec-id), reused across runs. `spec-id` charset is validated.
 */
export function specDir(dataDir: string, repo: string, specId: string): string {
    validateId(specId, 'spec-id')
    return join(specsRoot(dataDir), repoKey(repo), specId)
}

/**
 * `<docsRoot>/factory/<spec-id>` — the IN-REPO reviewable spec copy (F-specloc).
 *
 * `docsRoot` is the TARGET REPO's `docs/` dir (at `process.cwd()`), NOT the
 * out-of-repo dataDir — so this is keyed by `spec-id` alone (the repo IS the
 * checkout that owns `docs/`; there is no repo-key segment). The `spec-id`
 * charset is validated the same way {@link specDir} validates it, so a `../`
 * spec-id cannot traverse out of `docs/factory`.
 *
 * This is a MIRROR for human/PR review; the canonical read-path is {@link specDir}
 * in the dataDir. The TCB write-deny protects this subtree (`docs/factory/**`) so
 * an implementer cannot weaken its own acceptance criteria via the in-repo copy.
 */
export function docsFactoryDir(docsRoot: string, specId: string): string {
    validateId(specId, 'spec-id')
    return join(docsRoot, DOCS_FACTORY_DIR, specId)
}

/** Namespace subdir under the OS temp dir, so spec-build scratch doesn't scatter loose files into shared temp clutter. */
const SPEC_BUILD_TMP_NAMESPACE = 'factory-spec-build'

/**
 * The production root for {@link specBuildDir} — the OS temp dir, namespaced.
 * Callers that need isolation (tests) pass their own `root` to `specBuildDir`
 * directly instead of using this default.
 */
export function defaultSpecBuildRoot(): string {
    return join(tmpdir(), SPEC_BUILD_TMP_NAMESPACE)
}

/** `<root>/spec-build`. `root` is typically {@link defaultSpecBuildRoot}, NOT the plugin dataDir. */
export function specBuildRoot(root: string): string {
    return join(root, SPEC_BUILD_DIR)
}

/**
 * `<root>/spec-build/<repo-key>/<issue>` — the TRANSIENT scratch dir for an
 * in-progress spec build. Holds the prd/generated/verdict JSON threaded between
 * the runner-driven `factory spec resolve|gate|store` actions. Keyed by the
 * stable PRD issue number (not a spec-id — no spec exists yet), and DISCARDABLE:
 * unlike {@link specDir} this is never reused across runs, just a handoff buffer
 * for one generate/review loop. `root` is root-agnostic (any caller-supplied
 * directory works); production wiring passes {@link defaultSpecBuildRoot}.
 */
export function specBuildDir(root: string, repo: string, issueNumber: number): string {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new Error(`specBuildDir: issue number must be a positive integer, got ${issueNumber}`)
    }
    return join(specBuildRoot(root), repoKey(repo), String(issueNumber))
}
