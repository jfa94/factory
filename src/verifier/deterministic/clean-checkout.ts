/**
 * WS6 — gate-of-record: a TRUSTED LOCAL re-run in a CLEAN CHECKOUT (Δ Z).
 *
 * The authority of record is NOT CI — it is this local re-run of the GateRunner in
 * a clean worktree forked from origin/<base> tip (via WS3's createTaskWorktree).
 * CI is the final net. {@link runGatesInCleanCheckout} creates the worktree, runs
 * the gates THERE, and tears it down via removeWorktree EVEN ON THROW.
 *
 * WS3 git seams are injected so units exercise the create → run → teardown
 * lifecycle with FakeGitClient + a fake GateRunner, asserting the worktree is
 * removed even when a strategy throws.
 */
import { createTaskWorktree, removeWorktree, type GitClient } from "../../git/index.js";
import type { GateContext, GateRunResult, GateRunner } from "./gate-runner.js";

/** Args to {@link runGatesInCleanCheckout}. */
export interface CleanCheckoutArgs {
  /** WS3 git client (real DefaultGitClient or FakeGitClient). */
  readonly gitClient: GitClient;
  /** The runner whose verdict is the authority of record. */
  readonly runner: GateRunner;
  readonly runId: string;
  readonly taskId: string;
  /** Absolute path where the clean worktree is created. */
  readonly worktreePath: string;
  /** Base branch the clean checkout forks from (default: WS3 staging). */
  readonly base?: string;
  /** Remote to fetch the base from (default: origin). */
  readonly remote?: string;
  /**
   * Builds the GateContext for the clean worktree. Given the created worktree path
   * + its run-scoped branch, the caller supplies tools/config/gates. (Injected so
   * the clean-checkout runner stays agnostic of tool wiring.)
   */
  readonly buildContext: (created: { worktreePath: string; branch: string }) => GateContext;
}

/**
 * Run the gate sweep in a clean checkout and return its result — the GATE-OF-RECORD.
 * The worktree is always removed (teardown in a finally), even if the runner throws.
 */
export async function runGatesInCleanCheckout(args: CleanCheckoutArgs): Promise<GateRunResult> {
  const created = await createTaskWorktree({
    gitClient: args.gitClient,
    runId: args.runId,
    taskId: args.taskId,
    path: args.worktreePath,
    ...(args.remote !== undefined ? { remote: args.remote } : {}),
    ...(args.base !== undefined ? { base: args.base } : {}),
  });

  try {
    const ctx = args.buildContext({ worktreePath: created.path, branch: created.branch });
    return await args.runner.run(ctx);
  } finally {
    // Authority-of-record discipline: never leak the trusted worktree, even on throw.
    await removeWorktree(args.gitClient, created.path);
  }
}
