/**
 * WS6 — gate-of-record: a TRUSTED LOCAL re-run in a CLEAN CHECKOUT (Δ Z).
 *
 * The authority of record is NOT CI — it is this local re-run of the GateRunner in
 * a clean worktree forked from origin/<base> tip (via WS3's createTaskWorktree),
 * with the TASK'S CANDIDATE implementation checked out on top. CI is the final net.
 * {@link runGatesInCleanCheckout} creates the worktree, re-points it onto the
 * candidate, PROVES HEAD is the candidate before trusting anything, runs the gates
 * THERE, and tears it down via removeWorktree EVEN ON THROW.
 *
 * Why the candidate matters: a clean worktree forked from pristine origin/<base>
 * holds NO task code, so `diff origin/<base>...HEAD` is empty and every gate would
 * pass over code that was never produced — a green gate-of-record for unbuilt work.
 * The candidate checkout + the HEAD==candidate assertion close that gap: the
 * verdict is only ever derived over the reviewed tree.
 *
 * WS3 git seams are injected so units exercise the create → checkout → run →
 * teardown lifecycle with FakeGitClient + a fake GateRunner, asserting the worktree
 * is removed even when a strategy throws, and that a candidate/HEAD mismatch fails
 * loud before any verdict is derived.
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
  /**
   * The task's candidate implementation ref (e.g. the run-scoped task branch or a
   * commit sha) to check out in the clean worktree and validate. REQUIRED — without
   * it the gate-of-record would validate pristine `base`, not the task's output.
   */
  readonly candidateRef: string;
  /**
   * Optional pin: if provided, the checked-out HEAD must equal this sha (the exact
   * commit the panel reviewed). Guards against `candidateRef` having moved between
   * review and re-run. A mismatch fails loud before any verdict is derived.
   */
  readonly expectedSha?: string;
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
    const opts = { cwd: created.path };
    // Layer the CANDIDATE onto the clean worktree, then PROVE HEAD is the candidate
    // before deriving any verdict — otherwise the gates would validate pristine base.
    await args.gitClient.checkoutB(created.branch, args.candidateRef, opts);

    const head = await args.gitClient.revParse("HEAD", opts);
    const candidate = await args.gitClient.revParse(args.candidateRef, opts);
    if (head !== candidate) {
      throw new Error(
        `clean-checkout: HEAD=${head} != candidate ${args.candidateRef}=${candidate} — ` +
          `refusing to derive a gate-of-record verdict over the wrong tree`,
      );
    }
    if (args.expectedSha !== undefined && head !== args.expectedSha) {
      throw new Error(
        `clean-checkout: HEAD=${head} != expected candidate sha ${args.expectedSha} — ` +
          `the worktree is not at the reviewed commit; refusing to derive a verdict`,
      );
    }

    const ctx = args.buildContext({ worktreePath: created.path, branch: created.branch });
    return await args.runner.run(ctx);
  } finally {
    // Authority-of-record discipline: never leak the trusted worktree, even on throw.
    await removeWorktree(args.gitClient, created.path);
  }
}
