/**
 * WS12 — the run FINALIZE coordinator (§④ rollup + §⑤ outcome; Δ S, Decision 22).
 *
 * "Never ship silently." Once every task is terminal, finalize turns the run into
 * its outcome artifacts and ships them, in a RESUME-SAFE order:
 *
 *   1. derive the terminal status (decideFinalize — THROWS if any task is in-flight)
 *   2. build the deterministic run report (status overridden to the terminal,
 *      since state.status is still `running`/`paused` until step 7)
 *   3. persist report.md (atomic) under the run store
 *   4. emit run.finalized + per-failure telemetry (thin jsonl; never fatal)
 *   5. on a `failed` run, post ONE comment on the originating PRD issue listing every
 *      failed task (class + reason + unmet criteria) — GitHub issues are PRDs, not
 *      tasks; the per-task status already lives in the run state. Idempotent: a hidden
 *      run-id marker lets a resumed finalize detect its own prior comment and skip
 *      (Δ S; "without repeating dead ends"). The PRD is left OPEN.
 *   6. rollup fires only on `completed` (Decision 34 — develop receives whole PRDs
 *      only): open + CI-gate + squash-merge the per-run staging→develop rollup. A
 *      merged rollup then closes/comments the PRD issue and deletes the per-run
 *      staging branch (Decision 35: protection first, then branch — GitHub blocks
 *      deleting a protected ref). A `failed` run leaves develop untouched and keeps
 *      the branch + protection, banked for rescue / inspection.
 *   7. ONLY THEN flip the run terminal (state.finalize)
 *
 * state.finalize is LAST on purpose: a crash anywhere in 2–6 leaves the run
 * non-terminal, so a re-drive re-enters finalize — and every step is idempotent
 * (report rewrite, telemetry append, issue dedup, rollup resume-guard, PRD comment
 * gated on the first finalize, 404-tolerant branch GC). The run is flipped terminal
 * only once its outcome is fully shipped.
 *
 * no-merge cutover (ShipMode): the rollup PR is opened but never merged; the failure
 * comment is still posted (the failures are real regardless of merge).
 */
import {
  decideFinalize,
  rollup,
  buildPartialReport,
  renderPartialReportMarkdown,
  renderFailureComment,
  failureCommentMarker,
  recordRunFinalized,
  resolveStagingBranch,
  type Config,
  type GhClient,
  type GitClient,
  type RunState,
  type SpecManifest,
  type StateManager,
  type PartialRunReport,
  type RollupArgs,
  type RollupResult,
} from "./deps.js";
import type { ShipMode } from "./types.js";
import { atomicWriteFile, createLogger, nowIso } from "../shared/index.js";
import { runReportPath } from "../core/state/paths.js";

const log = createLogger("finalize");

/** Comment body posted to the PRD issue when the rollup merges (Decision 34). */
export function prdDoneComment(report: PartialRunReport, rollupResult: RollupResult): string {
  const prRef = rollupResult.url
    ? `[#${rollupResult.number}](${rollupResult.url})`
    : `#${rollupResult.number}`;
  return (
    `PRD delivered — all ${report.totals.shipped} task(s) shipped via rollup PR ${prRef}.\n\n` +
    `Spec: \`${report.spec_id}\` · Run: \`${report.run_id}\``
  );
}

/** The deps the finalize coordinator needs — a subset of {@link import("./orchestrator.js").OrchestratorDeps} + CLI deps. */
export interface FinalizeRunDeps {
  /** The only sanctioned state read/write path. */
  readonly state: StateManager;
  /** gh client for the rollup PR + per-failure issues. */
  readonly gh: GhClient;
  /**
   * git client for the forward-reconcile (fetch + merge + push) before the rollup.
   * Operates on the target repo working tree (process.cwd() by default).
   */
  readonly git: GitClient;
  /** The run's durable spec (source of the unmet acceptance criteria). */
  readonly spec: SpecManifest;
  /**
   * Resolved plugin config (provides `git.baseBranch` for the forward-reconcile +
   * rollup `baseBranch` arg).
   */
  readonly config: Config;
  /** Plugin data dir (roots the run store — report.md, metrics.jsonl). */
  readonly dataDir: string;
  /** Repo owner — used for the per-run staging-branch GC (deleteProtection / deleteRemoteBranch). */
  readonly owner: string;
  /** Repo name. */
  readonly repo: string;
  /** `live` merges the rollup; `no-merge` opens it but never auto-merges. */
  readonly shipMode: ShipMode;
  /**
   * ISO stamp for the report + telemetry (tests pin this). Defaults to nowIso().
   * Named `nowIso` (not `now`) so {@link import("./orchestrator.js").OrchestratorDeps} — whose
   * `now: () => number` is the quota epoch-seconds clock — assigns structurally to
   * this deps subset.
   */
  readonly nowIso?: string;
  /** Rollup CI-poll tuning (tests inject a no-op sleep + a tiny budget). */
  readonly rollup?: Pick<RollupArgs, "pollIntervalMs" | "maxPolls" | "sleep">;
}

/** The outcome of {@link finalizeRun}. */
export interface FinalizeRunResult {
  /** The run AFTER it was flipped to its terminal status. */
  readonly run: RunState;
  /** The deterministic report (also persisted to report.md + used as the rollup body). */
  readonly report: PartialRunReport;
  /** The rollup outcome, or undefined when nothing shipped (no rollup attempted). */
  readonly rollup?: RollupResult;
  /** Whether a NEW failure comment was posted to the PRD (deduped — a resume posts none). */
  readonly failureCommentPosted: boolean;
}

/** The rollup PR title — names the spec + originating PRD issue. */
function rollupTitle(report: PartialRunReport): string {
  return `factory: ${report.spec_id} → develop (PRD #${report.issue_number})`;
}

/**
 * On a `failed` run, post ONE comment on the originating PRD issue summarizing every
 * failed task. GitHub issues are PRDs, not tasks — the authoritative per-task status
 * lives in the run state; this is the human-facing "loud fail" surface (Δ S), PRD-scoped
 * and symmetric with the completed path's PRD-delivered comment. The PRD is left OPEN.
 *
 * Idempotent: the comment body carries a hidden run-id marker, so a resumed finalize
 * scans the PRD's existing comments and skips if its own comment is already there
 * (mirrors the old issue-title dedup). Returns whether a NEW comment was posted (a
 * resume posts none). A `completed` run has no failures → no comment here (its PRD
 * comment + close happens in the rollup step).
 */
async function commentFailuresOnPrd(
  deps: FinalizeRunDeps,
  report: PartialRunReport,
): Promise<boolean> {
  // Decision 39: a `failed` run with zero task failures (an e2e-only veto — every
  // task shipped) still needs the PRD comment, or "never ship silently" is broken.
  if (report.failures.length === 0 && report.e2e_failure === undefined) return false;

  const marker = failureCommentMarker(report.run_id);
  const existing = await deps.gh.listIssueComments({
    repo: report.repo,
    number: report.issue_number,
  });
  if (existing.some((body) => body.includes(marker))) {
    log.info(`failure comment already posted for run '${report.run_id}' — skipping duplicate`);
    return false;
  }

  await deps.gh.issueComment({
    repo: report.repo,
    number: report.issue_number,
    body: renderFailureComment(report),
  });
  return true;
}

/**
 * Finalize a run whose tasks are ALL terminal: build + persist the report, emit
 * telemetry, file the per-failure issues, ship the rollup, then flip the run terminal.
 * See the module header for the resume-safe ordering + idempotency contract.
 */
export async function finalizeRun(
  deps: FinalizeRunDeps,
  runId: string,
): Promise<FinalizeRunResult> {
  const now = deps.nowIso ?? nowIso();
  const run = await deps.state.read(runId);

  // 1. terminal status (throws loud if any task is non-terminal — anti-spin).
  // Decision 39: a `failed` e2e phase overrides the task-based verdict to `failed`
  // even when every task individually shipped — decideFinalize (WS2, pure
  // task-status) has no visibility into the e2e phase (residual critical red, an
  // unmappable critical regression, or a cap-exhausted critical), so the override
  // lives here, the run's finalize coordinator.
  const taskTerminal = decideFinalize(run).run_status;
  const terminal = run.e2e_phase?.status === "failed" ? "failed" : taskTerminal;

  // 2. report — status overridden to the DECIDED terminal (state flips in step 7).
  const report = buildPartialReport({ ...run, status: terminal }, deps.spec, { now });
  const markdown = renderPartialReportMarkdown(report);

  // 3. persist report.md (atomic full-file replace).
  await atomicWriteFile(runReportPath(deps.dataDir, runId), markdown);

  // 4. telemetry (swallows its own IO errors — never fatal).
  await recordRunFinalized(deps.dataDir, report, { now });

  // 5. on a failed run, one PRD comment summarizing the failures (deduped by run-id marker).
  // Decision 39 (debug driver, forward decl): a debug run isn't a whole-PRD delivery —
  // it loops review⇄fix passes on the debug session's OWN staging branch/PR, so the PRD
  // issue is never touched from finalize (the debug driver owns any PRD-facing comms).
  const failureCommentPosted = run.debug ? false : await commentFailuresOnPrd(deps, report);

  // 6. rollup — only on completed (Decision 34: develop receives whole PRDs only).
  //    On failed, develop is untouched (the PRD failure comment is already posted above).
  let rollupResult: RollupResult | undefined;
  if (terminal === "completed") {
    const stagingBranch = resolveStagingBranch(runId, run.staging_branch);
    // Forward-reconcile (Decision 33): bring develop's new commits into the run branch
    // (no force-push) so the rollup PR is up-to-date. A conflict here is
    // non-auto-recoverable → surfaces for rescue.
    await deps.git.fetch("origin", deps.config.git.baseBranch);
    await deps.git.mergeFfOrCommit(stagingBranch, `origin/${deps.config.git.baseBranch}`);
    await deps.git.push("origin", stagingBranch);

    rollupResult = await rollup({
      ghClient: deps.gh,
      stagingBranch,
      baseBranch: deps.config.git.baseBranch,
      title: rollupTitle(report),
      body: markdown,
      merge: deps.shipMode === "live",
      ...(deps.rollup ?? {}),
    });

    if (rollupResult.merged) {
      // PRD-delivered comment + close. issueComment is NOT idempotent (a re-posted
      // comment is a visible duplicate), so fire it ONLY on the first finalize — a
      // resumed finalize hits rollup()'s already-merged short-circuit (resumed === true)
      // and must not double-post. issueClose is naturally idempotent (closing a closed
      // issue is a no-op), so it stays unconditional. issue_number is a required field
      // (always ≥1), so there is no presence guard to make.
      // Decision 39 (debug driver, forward decl): a debug run's rollup targets the
      // debug session's own staging branch/PR, not a PRD delivery — the PRD comment +
      // close are skipped, but the branch GC below stays unconditional (it operates on
      // the debug run's real branch/PR regardless of PRD linkage).
      if (!run.debug) {
        if (!rollupResult.resumed) {
          await deps.gh.issueComment({
            repo: report.repo,
            number: report.issue_number,
            body: prdDoneComment(report, rollupResult),
          });
        }
        await deps.gh.issueClose({
          repo: report.repo,
          number: report.issue_number,
        });
      }
      // Branch GC (Decision 35): a completed+merged run is fully contained in develop, so
      // tear down its per-run staging branch. Protection FIRST — GitHub blocks deleting a
      // protected ref. Both ops are idempotent (404-tolerant), so a resumed finalize safely
      // repeats them. A `failed` run (or a `no-merge` open PR) keeps its branch + protection,
      // banked for rescue / inspection.
      await deps.gh.deleteProtection(deps.owner, deps.repo, stagingBranch);
      await deps.gh.deleteRemoteBranch(deps.owner, deps.repo, stagingBranch);
    }
  } else {
    log.warn(`run '${runId}': ${terminal} — develop untouched (no rollup, PRD left open)`);
  }

  // 7. flip terminal LAST (so a crash in 2–6 leaves the run resumable).
  const finalized = await deps.state.finalize(runId, terminal);
  log.info(
    `run '${runId}' finalized: ${terminal} ` +
      `(${report.totals.shipped} shipped, ${report.totals.failed} failed` +
      `${failureCommentPosted ? ", PRD failure comment posted" : ""}` +
      `${rollupResult ? `, rollup #${rollupResult.number} merged=${rollupResult.merged}` : ", no rollup"})`,
  );

  return {
    run: finalized,
    report,
    ...(rollupResult ? { rollup: rollupResult } : {}),
    failureCommentPosted,
  };
}
