/**
 * `src/git` — WS3 public seam: git/gh wrappers, worktree lifecycle, run-scoped
 * branch naming, idempotent PR create, the serial writer, and the
 * branch-protection probe/gate. Downstream (WS6/WS10/WS12) imports from HERE.
 *
 * This barrel re-exports ONLY src/git's own surface. It does NOT touch src/types
 * (WS0/1/2-owned) or any other frozen seam barrel.
 */

// exec seam (injectable runners)
export { makeRunner, runOrThrow, defaultGitRunner, defaultGhRunner } from "./exec-tools.js";
export type { CommandRunner, GitRunner, GhRunner } from "./exec-tools.js";

// git client
export { DefaultGitClient } from "./git-client.js";
export type { GitClient, GitOpts, PushOptions } from "./git-client.js";

// gh client
export { DefaultGhClient, parseGhJson } from "./gh-client.js";
export type {
  GhClient,
  GhOpts,
  PullRequest,
  CreatedPr,
  IssueCreateArgs,
  CreatedIssue,
  PrListArgs,
  PrCreateArgs,
  PrMergeOptions,
  ProtectionApiResult,
  ProtectionPutBody,
} from "./gh-client.js";

// run-scoped branch naming (Δ M)
export { runScopedBranch, isRunScopedBranch, parseRunScopedBranch } from "./branch.js";
export type { RunScopedBranchParts } from "./branch.js";

// worktree lifecycle (D12)
export {
  createTaskWorktree,
  assertBaseIsStagingTip,
  ensureOnStaging,
  removeWorktree,
} from "./worktree.js";
export type {
  CreateTaskWorktreeArgs,
  TaskWorktree,
  AssertBaseArgs,
  EnsureOnStagingArgs,
} from "./worktree.js";

// idempotent PR create (Δ P)
export { createTaskPrIdempotent } from "./pr.js";
export type { CreateTaskPrArgs, TaskPrResult } from "./pr.js";

// serial writer (Δ L / #1)
export { MergeSerializer } from "./serial-writer.js";
export type { MergeSerializerOptions, MergeOutcome, MergeLockTuning } from "./serial-writer.js";

// branch-protection probe + gate (#2 / Δ A)
export {
  probeProtection,
  requireProtectionOrRefuse,
  provisionProtection,
  ProtectionMissingError,
} from "./protection.js";
export type {
  ProtectionState,
  ProbeProtectionArgs,
  ProvisionProtectionArgs,
} from "./protection.js";

// staging-init / reconcile
export { ensureStaging } from "./staging.js";
export type { EnsureStagingArgs, EnsureStagingResult } from "./staging.js";

// fakes for downstream unit tests
export { FakeGitClient, FakeGhClient } from "./fakes.js";
export type { FakeGitOptions, FakeGhOptions } from "./fakes.js";
