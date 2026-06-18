/**
 * WS12 — the run FINALIZE coordinator (§④ rollup + §⑤ outcome; Δ S, Decision 22).
 *
 * "Never ship silently." Once every task is terminal, finalize turns the run into
 * its outcome artifacts and ships them, in a RESUME-SAFE order:
 *
 *   1. derive the terminal status (decideFinalize — THROWS if any task is in-flight)
 *   2. build the deterministic partial-run report (status overridden to the terminal,
 *      since state.status is still `running`/`paused` until step 7)
 *   3. persist report.md (atomic) under the run store
 *   4. emit run.finalized + per-drop telemetry (thin jsonl; never fatal)
 *   5. file ONE GitHub issue per dropped task — deduped against existing factory
 *      issues so a resumed finalize never double-files (Δ S; "without repeating dead
 *      ends")
 *   6. (only if something shipped) open + CI-gate + squash-merge the staging→develop
 *      rollup, carrying the `PARTIAL:` header on a partial run (git mechanics live in
 *      src/git/rollup; finalize just decides partial/merge)
 *   7. ONLY THEN flip the run terminal (state.finalize)
 *
 * state.finalize is LAST on purpose: a crash anywhere in 2–6 leaves the run
 * non-terminal, so a re-drive re-enters finalize — and every step is idempotent
 * (report rewrite, telemetry append, issue dedup, rollup resume-guard). The run is
 * flipped terminal only once its outcome is fully shipped.
 *
 * no-merge cutover (ShipMode): the rollup PR is opened but never merged; issues are
 * still filed (the drops are real regardless of merge).
 */
import {
  decideFinalize,
  rollup,
  buildPartialReport,
  renderPartialReportMarkdown,
  renderFailureIssue,
  recordRunFinalized,
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
import { runStagingBranch } from "../git/index.js";
import type { ShipMode } from "./types.js";
import { atomicWriteFile, createLogger, nowIso } from "../shared/index.js";
import { runReportPath } from "../core/state/paths.js";

const log = createLogger("finalize");

/** The label every factory-filed issue carries (the finalize dedup key). */
const FACTORY_ISSUE_LABEL = "factory";

/** The deps the finalize coordinator needs — a subset of {@link import("./coroutine.js").CoroutineDeps} + CLI deps. */
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
  /** Repo owner (unused directly; the canonical slug is the report's repo). */
  readonly owner: string;
  /** Repo name. */
  readonly repo: string;
  /** `live` merges the rollup; `no-merge` opens it but never auto-merges. */
  readonly shipMode: ShipMode;
  /**
   * ISO stamp for the report + telemetry (tests pin this). Defaults to nowIso().
   * Named `nowIso` (not `now`) so {@link import("./coroutine.js").CoroutineDeps} — whose
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
  /** How many NEW issues were filed (deduped — a resume files 0). */
  readonly issuesFiled: number;
}

/** The rollup PR title — names the spec + originating PRD issue. */
function rollupTitle(report: PartialRunReport): string {
  return `factory: ${report.spec_id} → develop (PRD #${report.issue_number})`;
}

/**
 * File one GitHub issue per dropped task, skipping any whose title already exists
 * among the repo's factory-labelled issues (so a resumed finalize does not
 * double-file). Returns the count of NEW issues filed.
 */
async function fileFailureIssues(deps: FinalizeRunDeps, report: PartialRunReport): Promise<number> {
  if (report.failures.length === 0) return 0;

  const existing = new Set(
    (
      await deps.gh.issueList({ repo: report.repo, labels: [FACTORY_ISSUE_LABEL], state: "all" })
    ).map((i) => i.title),
  );

  let filed = 0;
  for (const failure of report.failures) {
    const issue = renderFailureIssue(failure, report);
    if (existing.has(issue.title)) {
      log.info(`issue already filed for dropped task '${failure.task_id}' — skipping duplicate`);
      continue;
    }
    await deps.gh.issueCreate({
      title: issue.title,
      body: issue.body,
      repo: report.repo,
      labels: [FACTORY_ISSUE_LABEL, `factory:${failure.failure_class}`],
    });
    existing.add(issue.title); // guard a same-run duplicate (two drops, same title)
    filed += 1;
  }
  return filed;
}

/**
 * Finalize a run whose tasks are ALL terminal: build + persist the report, emit
 * telemetry, file the per-drop issues, ship the rollup, then flip the run terminal.
 * See the module header for the resume-safe ordering + idempotency contract.
 */
export async function finalizeRun(
  deps: FinalizeRunDeps,
  runId: string,
): Promise<FinalizeRunResult> {
  const now = deps.nowIso ?? nowIso();
  const run = await deps.state.read(runId);

  // 1. terminal status (throws loud if any task is non-terminal — anti-spin).
  const terminal = decideFinalize(run).run_status;

  // 2. report — status overridden to the DECIDED terminal (state flips in step 7).
  const report = buildPartialReport({ ...run, status: terminal }, deps.spec, { now });
  const markdown = renderPartialReportMarkdown(report);

  // 3. persist report.md (atomic full-file replace).
  await atomicWriteFile(runReportPath(deps.dataDir, runId), markdown);

  // 4. telemetry (swallows its own IO errors — never fatal).
  await recordRunFinalized(deps.dataDir, report, { now });

  // 5. one GH issue per drop, deduped against existing factory issues.
  const issuesFiled = await fileFailureIssues(deps, report);

  // 6. rollup — only when something shipped (an all-dropped run has nothing on
  //    staging beyond base; opening a no-diff PR would fail).
  let rollupResult: RollupResult | undefined;
  if (report.totals.shipped > 0) {
    const stagingBranch = runStagingBranch(runId);
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
      partial: terminal === "partial",
      merge: deps.shipMode === "live",
      ...(deps.rollup ?? {}),
    });
  } else {
    log.warn(`run '${runId}': 0 tasks shipped — no rollup PR (nothing on staging to ship)`);
  }

  // 7. flip terminal LAST (so a crash in 2–6 leaves the run resumable).
  const finalized = await deps.state.finalize(runId, terminal);
  log.info(
    `run '${runId}' finalized: ${terminal} ` +
      `(${report.totals.shipped} shipped, ${report.totals.failed} failed, ${issuesFiled} issue(s) filed` +
      `${rollupResult ? `, rollup #${rollupResult.number} merged=${rollupResult.merged}` : ", no rollup"})`,
  );

  return { run: finalized, report, ...(rollupResult ? { rollup: rollupResult } : {}), issuesFiled };
}
