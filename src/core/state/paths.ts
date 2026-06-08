/**
 * WS1 — the two-store filesystem layout (plan §"State storage model").
 *
 * All run/spec state lives OUTSIDE the target repo, under the plugin data dir
 * (`resolveDataDir()` from src/config). This is a hard requirement: the holdout
 * answer-key must be unreadable from an executor worktree (Decision 5 / Δ Y), so
 * state cannot live in-repo.
 *
 * Two stores:
 *   - DURABLE spec store:  <dataDir>/specs/<repo-key>/<spec-id>/   (Δ X)
 *       Reused across runs; keyed by (repo, spec-id), NOT by run id.
 *   - EPHEMERAL run store: <dataDir>/runs/<run-id>/                 (per run)
 *       state.json + audit.jsonl + metrics.jsonl + holdouts/ + reviews/.
 *
 * `<repo-key>` is a sanitized path segment derived from a "owner/name" repo id
 * (the slash and any unsafe char folded to '-') so the spec store is one flat,
 * inspectable directory level per repo.
 */
import { join } from "node:path";
import { validateId } from "../../shared/ids.js";

/** Subdir name for the durable spec store. */
export const SPECS_DIR = "specs";
/** Subdir name for the TRANSIENT spec-build scratch area. */
export const SPEC_BUILD_DIR = "spec-build";
/** Subdir name for the ephemeral run store. */
export const RUNS_DIR = "runs";
/** Symlink name pointing at the active run. */
export const CURRENT_LINK = "current";
/** The per-run state file name. */
export const STATE_FILE = "state.json";

/**
 * Sanitize a repo id (e.g. "owner/name") into a single safe path segment.
 * Folds `/` and any char outside [a-zA-Z0-9._-] to '-', collapses runs, trims.
 * Distinct from `slugify` (which lowercases + caps at 50 and is for human slugs):
 * a repo key must be reversible-ish and case-preserving for addressability, so it
 * keeps case and dots and does not truncate.
 */
export function repoKey(repo: string): string {
  const key = repo
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (key.length === 0) {
    throw new Error(`repoKey: repo '${repo}' has no usable characters`);
  }
  // Dots are kept for addressability (e.g. "My.Repo"), but a PURE-dot segment is
  // a path-traversal escape: `repoKey("..")` would yield ".." and let specDir()
  // climb out of the spec store. validateId already rejects this for run-id and
  // spec-id; repo is the one segment that bypasses it, so reject it loudly here.
  if (/^\.+$/.test(key)) {
    throw new Error(`repoKey: repo '${repo}' resolves to a path-traversal segment '${key}'`);
  }
  return key;
}

/** `<dataDir>/runs`. */
export function runsRoot(dataDir: string): string {
  return join(dataDir, RUNS_DIR);
}

/** `<dataDir>/runs/<run-id>`. Validates run-id charset. */
export function runDir(dataDir: string, runId: string): string {
  validateId(runId, "run-id");
  return join(runsRoot(dataDir), runId);
}

/** `<dataDir>/runs/<run-id>/state.json`. */
export function runStatePath(dataDir: string, runId: string): string {
  return join(runDir(dataDir, runId), STATE_FILE);
}

/** `<dataDir>/runs/current` symlink path. */
export function currentLinkPath(dataDir: string): string {
  return join(runsRoot(dataDir), CURRENT_LINK);
}

/** `<dataDir>/specs`. */
export function specsRoot(dataDir: string): string {
  return join(dataDir, SPECS_DIR);
}

/**
 * `<dataDir>/specs/<repo-key>/<spec-id>` — the durable per-spec dir (Δ X).
 * Keyed by (repo, spec-id), reused across runs. `spec-id` charset is validated.
 */
export function specDir(dataDir: string, repo: string, specId: string): string {
  validateId(specId, "spec-id");
  return join(specsRoot(dataDir), repoKey(repo), specId);
}

/** `<dataDir>/spec-build`. */
export function specBuildRoot(dataDir: string): string {
  return join(dataDir, SPEC_BUILD_DIR);
}

/**
 * `<dataDir>/spec-build/<repo-key>/<issue>` — the TRANSIENT scratch dir for an
 * in-progress spec build. Holds the prd/generated/verdict JSON threaded between
 * the orchestrator-driven `factory spec resolve|gate|store` actions. Keyed by the
 * stable PRD issue number (not a spec-id — no spec exists yet), and DISCARDABLE:
 * unlike {@link specDir} this is never reused across runs, just a handoff buffer
 * for one generate/review loop.
 */
export function specBuildDir(dataDir: string, repo: string, issueNumber: number): string {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`specBuildDir: issue number must be a positive integer, got ${issueNumber}`);
  }
  return join(specBuildRoot(dataDir), repoKey(repo), String(issueNumber));
}
