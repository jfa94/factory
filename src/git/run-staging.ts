/**
 * Per-run integration branch (Decision 33). Each run integrates its task PRs on a
 * PRIVATE `staging/<run-id>` branch cut from `develop` at `run create`, so an
 * unfinished run's work never sits on a shared branch — that is what lets
 * supersede/resume/rescue stay non-destructive to `develop`.
 */
export const RUN_STAGING_PREFIX = "staging";

/** Map a run id to its per-run staging branch (`staging/<run-id>`). LOUD on empty. */
export function runStagingBranch(runId: string): string {
  if (runId.length === 0) {
    throw new Error("runStagingBranch: empty run id (would yield a bare 'staging/' branch)");
  }
  return `${RUN_STAGING_PREFIX}/${runId}`;
}
