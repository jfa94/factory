/**
 * `factory recover` — ONE self-routing repair verb for a stalled run (S10,
 * Decision 48). Zero new pipeline logic: pure ROUTING over the existing seams —
 * {@link scanRun} (classify), {@link assessWork} (git-drift evidence),
 * {@link applyRescue} (reset/reopen), {@link applyResume} (quota gate / park
 * clear). `factory resume` and `factory rescue` stay registered as the
 * flag-rich escape hatches; this verb is the "just fix it" front door.
 *
 * Routes, resolved in order from the run's state + scan:
 *   1. no run                    → {kind:"nothing", reason:"no-run"}
 *   2. completed/superseded      → {kind:"nothing"} (+ --recheck-rollup hint when armed)
 *   3. paused/suspended + clean  → resume via applyResume (A2: a quota-absent park
 *                                  clears unconditionally); envelope carries the
 *                                  DERIVED "awaiting" cause — never a stored reason
 *   4. resettable work           → applyRescue (default set) + clear any surviving
 *                                  park; `reconcile:true` flags git drift so the
 *                                  COMMAND doc spawns rescue-reconciler (the CLI
 *                                  never spawns agents, Model A)
 *   5. dead-ends/e2e only        → {kind:"page"} with per-task rescue-apply hints
 *
 * `--auto` is the runner's bounded self-heal, fired ONCE after a failed
 * finalize: the auto-safe reset happens (→ {kind:"recovered"}) or the CLI pages
 * (→ {kind:"page"}) and posts ONE deduped comment on the originating PRD.
 * Both envelopes are EXIT.OK — a page is a routed outcome, not a CLI failure.
 */
import { EXIT, type ExitCode } from "../../shared/exit-codes.js";
import { parseArgs, UsageError } from "../args.js";
import { emitJson, emitLine } from "../io.js";
import { loadConfig, resolveDataDir } from "../../config/index.js";
import { StateManager } from "../../core/state/index.js";
import { readCurrentForCwd, type CurrentRunOverrides } from "../current.js";
import {
  scanRun,
  applyRescue,
  assessWork,
  type RescueScan,
  type WorkProbe,
} from "../../rescue/index.js";
import { DefaultGitClient, DefaultGhClient, type GhClient } from "../../git/index.js";
import { StatuslineUsageSignal } from "../../quota/index.js";
import { nowEpoch, nowIso } from "../../shared/time.js";
import { selfHealCommentMarker } from "../../scoring/index.js";
import { requireAutonomousMode } from "../../autonomy/mode.js";
import { applyResume } from "./run.js";
import { withUsageGuard, type Subcommand } from "../registry-types.js";
import type { RunState } from "../../types/index.js";

const RECOVER_HELP = `factory recover — one self-routing repair verb for a stalled run

Usage:
  factory recover [--run <id>] [--dry-run]
  factory recover --auto [--run <id>]

Routes (resolved in order from the run's state + scan):
  1. no run                     → {kind:"nothing"}
  2. completed/superseded       → {kind:"nothing"} (+ recheck-rollup hint when armed)
  3. paused/suspended, clean    → resume (clears the park; envelope names what the
                                  run was awaiting: quota|e2e|traceability|docs|
                                  spec-approval)
  4. resettable work            → rescue apply + resume; reconcile:true flags git
                                  drift (recorded branch missing / staging base gone)
  5. dead-ends / e2e only       → {kind:"page"} with per-task rescue-apply hints

  --run      The run to recover (defaults to runs/current).
  --dry-run  Emit the scan + the chosen route; write nothing.
  --auto     The runner's bounded self-heal (ONE cycle per run, after a failed
             finalize): reset the auto-safe set (stuck + recoverable tasks whose
             deps are clean post-reset) → {kind:"recovered"}, or page + post one
             deduped PRD comment → {kind:"page"}. Never touches dead-ends, e2e
             verdicts, or rollups. Both envelopes exit 0.`;

/** Test seam: current-run resolution + gh (the PRD page comment) + the clock. */
export interface RecoverOverrides extends CurrentRunOverrides {
  readonly ghClient?: GhClient;
  /** ISO clock for `self_heal.last_at` (defaults to {@link nowIso}). */
  readonly now?: () => string;
}

/** The route labels `--dry-run` reports and the executor switches on. */
export type RecoverRoute = "nothing" | "resume" | "rescue" | "page";

/**
 * What a parked (paused/suspended) run is waiting on — DERIVED from the state
 * markers, never stored (derive-don't-store). Pure display string for the
 * resume envelope; "unknown" is the honest fallback, not an error.
 */
export function deriveAwaiting(run: RunState): string {
  if (run.quota !== undefined) return "quota"; // A2: present ⇔ quota-caused stop
  if (run.e2e_assessment?.status === "failed" || run.e2e_phase?.status === "failed") return "e2e";
  if (run.traceability?.status === "failed") return "traceability";
  if (run.docs?.status === "failed") return "docs";
  // S9 --approve-spec park: suspended straight after create, no task ever touched.
  const untouched = Object.values(run.tasks).every(
    (t) => t.status === "pending" && t.started_at === undefined,
  );
  return untouched ? "spec-approval" : "unknown";
}

/** Pick the route for a live run (route 1, no-run, is handled by the caller). */
export function chooseRoute(run: RunState, scan: RescueScan): RecoverRoute {
  if (run.status === "completed" || run.status === "superseded") return "nothing";
  if ((run.status === "paused" || run.status === "suspended") && !scan.needs_rescue) {
    return "resume";
  }
  if (scan.resettable.length > 0) return "rescue";
  if (!scan.needs_rescue && scan.dead_ends.length === 0) return "nothing"; // healthy
  return "page"; // dead-ends only, or a failed e2e/assessment verdict
}

/** Human next-step hints for the page envelope, one command per repair. */
function pageHints(runId: string, scan: RescueScan): string[] {
  const hints = scan.dead_ends.map(
    (id) => `factory rescue apply --run ${runId} --task ${id} --include-dead-ends`,
  );
  if (scan.e2e_failed || scan.e2e_assessment_failed) {
    hints.push(`factory rescue apply --run ${runId} --reset-e2e`);
  }
  return hints;
}

/** Route 3/4 shared tail: clear a surviving park via the resume quota gate. */
async function resumeRun(
  state: StateManager,
  runId: string,
  dataDir: string,
): Promise<Awaited<ReturnType<typeof applyResume>>> {
  const reading = await new StatuslineUsageSignal({ dataDir }).read();
  return applyResume(state, runId, reading, loadConfig({ dataDir }), nowEpoch());
}

async function run(argv: string[], overrides: RecoverOverrides = {}): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: ["auto", "dry-run"] });
  if (args.flag("help") === true) {
    emitLine(RECOVER_HELP);
    return EXIT.OK;
  }
  const auto = args.flag("auto") === true;
  const dryRun = args.flag("dry-run") === true;
  if (auto && dryRun) throw new UsageError("recover: --auto and --dry-run are mutually exclusive");

  const dataDir = resolveDataDir({});
  const state = new StateManager({ dataDir });

  // Route 1 — no run is a routed answer here, not a usage error (unlike rescue):
  // "factory recover" must be safe to fire blind.
  const explicit = args.flag("run");
  const current =
    typeof explicit === "string" && explicit.length > 0
      ? await state.read(explicit)
      : await readCurrentForCwd(state, overrides);
  if (current === null) {
    emitJson({ kind: "nothing", reason: "no-run" });
    return EXIT.OK;
  }
  const runId = current.run_id;
  const scan = scanRun(current);

  if (auto) return runAuto(state, current, scan, overrides);

  const route = chooseRoute(current, scan);

  if (dryRun) {
    const work = await assessWork(current, probeFrom(overrides));
    emitJson({ ...scan, work, route });
    return EXIT.OK;
  }

  switch (route) {
    case "nothing": {
      const hint = scan.rollup_pending
        ? {
            hint: `rollup armed but not landed — factory rescue apply --run ${runId} --recheck-rollup once merged`,
          }
        : {};
      emitJson({ kind: "nothing", run_id: runId, run_status: current.status, ...hint });
      return EXIT.OK;
    }
    case "resume": {
      requireAutonomousMode(); // same gate as `factory resume` — this re-activates a run
      const awaiting = deriveAwaiting(current);
      const envelope = await resumeRun(state, runId, dataDir);
      emitJson({ ...envelope, awaiting });
      return EXIT.OK;
    }
    case "rescue": {
      requireAutonomousMode();
      const applied = await applyRescue(state, runId, {});
      // A rescued run can still be parked (paused/suspended, non-terminal) — clear
      // it through the same quota gate resume uses, so ONE verb fully re-activates.
      const after = await state.read(runId);
      const resume =
        after.status === "paused" || after.status === "suspended"
          ? await resumeRun(state, runId, dataDir)
          : undefined;
      const work = await assessWork(current, probeFrom(overrides));
      // v1 drift predicate: a recorded task branch whose ref is gone, or the run's
      // staging base unresolvable. The COMMAND doc routes reconcile:true to the
      // rescue-reconciler agent; this CLI never spawns it (Model A).
      const reconcile = !work.base_resolved || work.tasks.some((t) => !t.branch_exists);
      emitJson({
        kind: "rescued",
        ...applied,
        ...(resume?.kind === "resumed" ? { run_status: resume.run.status } : {}),
        reconcile,
        ...(resume !== undefined ? { resume } : {}),
      });
      return EXIT.OK;
    }
    case "page": {
      emitJson({
        kind: "page",
        run_id: runId,
        run_status: current.status,
        reason: scan.summary,
        dead_ends: scan.dead_ends,
        hints: pageHints(runId, scan),
      });
      return EXIT.OK;
    }
  }
}

/**
 * The `--auto` leg: ONE bounded self-heal cycle. Success recovers; a blocked
 * apply pages AND posts one deduped comment on the originating PRD (the runner
 * is unattended — stdout alone reaches nobody).
 */
async function runAuto(
  state: StateManager,
  current: RunState,
  scan: RescueScan,
  overrides: RecoverOverrides,
): Promise<ExitCode> {
  requireAutonomousMode();
  const at = overrides.now?.() ?? nowIso();
  const applied = await applyRescue(state, current.run_id, { auto: { at } });

  if (applied.auto_blocked === undefined) {
    emitJson({
      kind: "recovered",
      run_id: current.run_id,
      run_status: applied.run_status,
      reset: applied.reset,
      reopened: applied.reopened,
      attempts: applied.self_heal_attempts,
    });
    return EXIT.OK;
  }

  const reason =
    applied.auto_blocked === "attempts"
      ? "self-heal already ran once for this run — human triage required"
      : "nothing auto-recoverable (dead-ends, blocked dependencies, or no resettable work) — human triage required";

  const gh = overrides.ghClient ?? new DefaultGhClient();
  const marker = selfHealCommentMarker(current.run_id);
  const target = { repo: current.spec.repo, number: current.spec.issue_number };
  const existing = await gh.listIssueComments(target);
  let commented = false;
  if (!existing.some((body) => body.includes(marker))) {
    const lines = [
      marker,
      `Factory self-heal for run \`${current.run_id}\` did not proceed — ${reason}.`,
    ];
    if (scan.dead_ends.length > 0) {
      lines.push("", "Dead-end task(s) needing a human fix:");
      for (const id of scan.dead_ends) lines.push(`- \`${id}\``);
    }
    lines.push("", `Triage with \`factory recover --run ${current.run_id} --dry-run\`.`);
    await gh.issueComment({ ...target, body: lines.join("\n") });
    commented = true;
  }

  emitJson({
    kind: "page",
    run_id: current.run_id,
    run_status: current.status,
    reason,
    dead_ends: scan.dead_ends,
    hints: pageHints(current.run_id, scan),
    commented,
  });
  return EXIT.OK;
}

/** The read-only git probe for {@link assessWork} (same wiring as rescue scan). */
function probeFrom(overrides: RecoverOverrides): WorkProbe {
  const git = overrides.gitClient ?? new DefaultGitClient();
  return {
    refExists: (ref) => git.refExists(ref),
    commitsAhead: (base, branch) => git.commitsAhead(base, branch),
  };
}

/** Exported for tests (and the rescue-scan alias) with the overrides seam. */
export async function runRecover(
  argv: string[],
  overrides: RecoverOverrides = {},
): Promise<ExitCode> {
  return run(argv, overrides);
}

export const recoverCommand: Subcommand = {
  describe: "Self-routing repair: resume, rescue, or page — whatever the run needs",
  run: withUsageGuard("recover", (argv) => run(argv)),
};
