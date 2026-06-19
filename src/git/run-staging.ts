/**
 * Per-run integration branch (Decision 33). Each run integrates its task PRs on a
 * PRIVATE `staging-<run-id>` branch cut from `develop` at `run create`, so an
 * unfinished run's work never sits on a shared branch — that is what lets
 * supersede/resume/rescue stay non-destructive to `develop`.
 *
 * The delimiter is a hyphen, NOT a slash: git stores refs as files, so a slashed
 * `staging/<run-id>` needs `staging` to be a directory and collides with a repo's
 * long-lived `refs/heads/staging` release branch (`develop → staging → main`).
 * A flat `staging-<run-id>` shares no path segment with `refs/heads/staging`, so
 * the two coexist regardless of the target repo's branch layout.
 */
export const RUN_STAGING_PREFIX = "staging";

/** Map a run id to its per-run staging branch (`staging-<run-id>`). LOUD on empty. */
export function runStagingBranch(runId: string): string {
  if (runId.length === 0) {
    throw new Error("runStagingBranch: empty run id (would yield a bare 'staging-' branch)");
  }
  return `${RUN_STAGING_PREFIX}-${runId}`;
}

/**
 * Resolve a run's staging branch: the name PINNED on the run row at create
 * (`RunState.staging_branch`) when present, else recompute from the run id (legacy
 * runs predating the pin). Reading the pin keeps every base-ref consumer agreed on
 * the branch the run actually cut — a mid-run naming-scheme change can't desync them.
 *
 * Pure: takes the id + optional pinned name, never the `RunState` type, so it stays
 * in the git layer without importing core/state (preserves the layering direction).
 * A blank pin is treated as unset (falls back) — the fallback then re-applies the
 * empty-run-id loud guard.
 */
export function resolveStagingBranch(runId: string, pinned?: string): string {
  if (pinned !== undefined && pinned.length > 0) {
    return pinned;
  }
  return runStagingBranch(runId);
}
