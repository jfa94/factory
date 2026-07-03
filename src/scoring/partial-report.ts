/**
 * WS12 — the deterministic partial-run report (Decision 22, Δ S).
 *
 * "Never ship silently." When a run finalizes to `completed` or `failed`
 * (Decision 34: develop receives only complete PRDs), this module turns the
 * persisted {@link RunState} + the durable {@link SpecManifest} into a precise,
 * deterministic account of WHAT shipped and WHAT failed and WHY — the source of
 * truth for the PRD failure comment (Decision 36) and the rollup PR body. It is also
 * useful mid-flight (a `suspended`/`paused` run) to describe which tasks are still
 * incomplete.
 *
 * PURE + DERIVE-DON'T-STORE: the report is computed afresh from ground truth
 * (task status + the spec's acceptance criteria) every time. Nothing here is read
 * back from a stored "report" blob. The builder takes an explicit `now` so a test
 * pins `generated_at` deterministically.
 *
 * Honesty over guesswork: a `failed` task never cleared the merge gate, so it
 * met NONE of its acceptance criteria. The report lists the task's FULL acceptance
 * criteria as `unmet_criteria` rather than fabricating per-criterion satisfaction
 * the runtime never recorded.
 */
import type { RunState, RunStatus, FailureClass } from "../types/index.js";
import type { SpecManifest, SpecTask } from "../spec/schema.js";
import { nowIso } from "../shared/index.js";

/** A task that merged into staging (status `done`). */
export interface ShippedLine {
  task_id: string;
  title: string;
  branch?: string;
  pr_number?: number;
}

/** A task that was a classified loud failure (status `failed`). */
export interface FailureLine {
  task_id: string;
  title: string;
  /** Closed-enum cause (set IFF failed — guaranteed present by the schema). */
  failure_class: FailureClass;
  /** Human-facing reason recorded at failure time. */
  failure_reason: string;
  /**
   * The failed task's FULL acceptance criteria — all unmet, because a failure never
   * cleared the merge gate. Sourced from the durable spec, not fabricated.
   */
  unmet_criteria: string[];
  branch?: string;
  pr_number?: number;
}

/** A task that is neither shipped nor failed (only on a non-terminal run). */
export interface IncompleteLine {
  task_id: string;
  title: string;
  /** The live, non-terminal status (`pending`/`executing`/`reviewing`/`shipping`). */
  status: RunState["tasks"][string]["status"];
}

/** The structured partial-run report. Deterministic given (run, request, now). */
export interface PartialRunReport {
  run_id: string;
  run_status: RunStatus;
  spec_id: string;
  issue_number: number;
  repo: string;
  /** ISO-8601 stamp the report was built at. */
  generated_at: string;
  totals: { total: number; shipped: number; failed: number; incomplete: number };
  /** Shipped tasks, ordered by their position in the spec. */
  shipped: ShippedLine[];
  /** Failed (failed) tasks, ordered by their position in the spec. */
  failures: FailureLine[];
  /** Incomplete tasks (non-terminal run only), ordered by their position in the spec. */
  incomplete: IncompleteLine[];
  /**
   * The e2e phase's failure reason (Decision 39), present IFF `run.e2e_phase.status
   * === "failed"`. This is the ONLY way a `failed` run_status can coexist with an
   * empty `failures` list — every task shipped, but a residual critical red / an
   * unmappable critical regression / a cap-exhausted critical vetoed the rollup. The
   * PRD comment + rollup-PR body must surface this or "never ship silently" is broken.
   */
  e2e_failure?: string;
  /**
   * Non-gating e2e note (Decision 9) — e.g. residual THROWAWAY red that did NOT
   * block completion. Present IFF `run.e2e_phase.status === "done"` and the phase
   * left an advisory. Mutually exclusive with {@link e2e_failure} (one phase
   * outcome, one note).
   */
  e2e_advisory?: string;
  /**
   * Plain-language journey names the e2e suite covered (Decision 40 D12) — the
   * author manifest's `title`s (spec_path fallback for pre-D12 manifests). Present
   * IFF a manifest was authored, so a non-technical reader sees WHAT was verified
   * end-to-end, not just pass/fail.
   */
  e2e_journeys?: string[];
  /** Task ids the e2e phase reopened at least once (D12's "found & sent back for fixes"). */
  e2e_reopened?: string[];
  /**
   * Non-fatal e2e setup warnings (Decision 40 D3) — e.g. the assessment degraded to
   * logged-out coverage because auth machinery couldn't be authored.
   */
  e2e_warnings?: string[];
  /** The run-start e2e assessment's failure reason (Decision 40 D3c), IFF it failed. */
  e2e_assessment_failure?: string;
  /**
   * Δ U/S5 — tasks whose ADVANCING verify pass ran WITHOUT an independent
   * cross-vendor reviewer (task.cross_vendor_absent), in spec order. Present IFF
   * non-empty, so a run reviewed entirely single-vendor is visible in the report,
   * not just a buried log.warn.
   */
  cross_vendor_absences?: { task_id: string; reason: string }[];
}

/** Options for {@link buildPartialReport}. */
export interface BuildPartialReportOptions {
  /** Override the `generated_at` stamp (tests pin this). Defaults to `nowIso()`. */
  now?: string;
}

/**
 * Build the deterministic partial-run report from the run state + the spec it was
 * seeded from.
 *
 * Every task in the run MUST exist in the request — they were seeded from it. A
 * run task absent from the spec is a (repo, spec-id) mismatch (the wrong spec was
 * paired with the run), which is a real integrity defect, so it throws LOUD rather
 * than silently omitting the task or fabricating empty criteria.
 *
 * Output lists are ordered by the task's position in `request.tasks` (stable,
 * human-meaningful), not by the unordered `run.tasks` record.
 */
export function buildPartialReport(
  run: RunState,
  request: SpecManifest,
  opts: BuildPartialReportOptions = {},
): PartialRunReport {
  const specById = new Map<string, SpecTask>(request.tasks.map((t) => [t.task_id, t]));
  const orderOf = new Map<string, number>(request.tasks.map((t, i) => [t.task_id, i]));

  const shipped: ShippedLine[] = [];
  const failures: FailureLine[] = [];
  const incomplete: IncompleteLine[] = [];

  for (const task of Object.values(run.tasks)) {
    const spec = specById.get(task.task_id);
    if (spec === undefined) {
      throw new Error(
        `buildPartialReport: run task '${task.task_id}' is absent from spec '${request.spec_id}' ` +
          `— run/spec mismatch (wrong spec paired with run ${run.run_id})`,
      );
    }
    if (task.status === "done") {
      shipped.push({
        task_id: task.task_id,
        title: spec.title,
        branch: task.branch,
        pr_number: task.pr_number,
      });
    } else if (task.status === "failed") {
      // The schema guarantees a failed task carries both (cross-field refinement).
      failures.push({
        task_id: task.task_id,
        title: spec.title,
        failure_class: task.failure_class!,
        failure_reason: task.failure_reason!,
        unmet_criteria: [...spec.acceptance_criteria],
        branch: task.branch,
        pr_number: task.pr_number,
      });
    } else {
      incomplete.push({ task_id: task.task_id, title: spec.title, status: task.status });
    }
  }

  const bySpecOrder = <T extends { task_id: string }>(a: T, b: T): number =>
    (orderOf.get(a.task_id) ?? 0) - (orderOf.get(b.task_id) ?? 0);
  shipped.sort(bySpecOrder);
  failures.sort(bySpecOrder);
  incomplete.sort(bySpecOrder);

  return {
    run_id: run.run_id,
    run_status: run.status,
    spec_id: run.spec.spec_id,
    issue_number: run.spec.issue_number,
    repo: run.spec.repo,
    generated_at: opts.now ?? nowIso(),
    totals: {
      total: shipped.length + failures.length + incomplete.length,
      shipped: shipped.length,
      failed: failures.length,
      incomplete: incomplete.length,
    },
    shipped,
    failures,
    incomplete,
    ...(run.e2e_phase?.status === "failed" ? { e2e_failure: run.e2e_phase.reason } : {}),
    ...(run.e2e_phase?.status === "done" && run.e2e_phase.advisory !== undefined
      ? { e2e_advisory: run.e2e_phase.advisory }
      : {}),
    ...buildE2eNarrative(run),
    ...buildCrossVendorAbsences(run, bySpecOrder),
  };
}

/** Δ U/S5 — the review-independence field (tasks reviewed without a second vendor). */
function buildCrossVendorAbsences(
  run: RunState,
  bySpecOrder: <T extends { task_id: string }>(a: T, b: T) => number,
): Partial<PartialRunReport> {
  const absences = Object.values(run.tasks)
    .filter((t) => t.cross_vendor_absent !== undefined)
    .map((t) => ({ task_id: t.task_id, reason: t.cross_vendor_absent!.reason }))
    .sort(bySpecOrder);
  return absences.length > 0 ? { cross_vendor_absences: absences } : {};
}

/** The D12 plain-language e2e fields (journeys/reopens/warnings/assessment failure). */
function buildE2eNarrative(run: RunState): Partial<PartialRunReport> {
  const journeys = (run.e2e_phase?.manifest ?? []).map((e) => e.title ?? e.spec_path);
  const reopened = Object.entries(run.e2e_phase?.reopen_counts ?? {})
    .filter(([, n]) => n > 0)
    .map(([id]) => id)
    .sort();
  const warning = run.e2e_assessment?.warning;
  return {
    ...(journeys.length > 0 ? { e2e_journeys: journeys } : {}),
    ...(reopened.length > 0 ? { e2e_reopened: reopened } : {}),
    ...(warning !== undefined ? { e2e_warnings: [warning] } : {}),
    ...(run.e2e_assessment?.status === "failed"
      ? { e2e_assessment_failure: run.e2e_assessment.reason ?? "e2e assessment failed" }
      : {}),
  };
}

/**
 * D12 reason convention: engine reasons may be `"<plain>\n<detail>"` — the first
 * line reads as a sentence for a non-technical reader; the remainder is technical
 * detail the renderers set apart instead of inlining.
 */
function splitReason(reason: string): { plain: string; detail?: string } {
  const i = reason.indexOf("\n");
  return i === -1 ? { plain: reason } : { plain: reason.slice(0, i), detail: reason.slice(i + 1) };
}

/**
 * The hidden HTML-comment marker that tags the PRD failure comment with its run id.
 * Single source of truth for both the renderer (which embeds it) and finalize's
 * idempotency check (which scans existing PRD comments for it), so a resumed
 * finalize detects its own prior comment and never double-posts.
 */
export function failureCommentMarker(runId: string): string {
  return `<!-- factory:run-failed:${runId} -->`;
}

/**
 * Render the failed tasks of a failed run as ONE markdown comment for the
 * originating PRD issue. Replaces the retired one-issue-per-failure behavior: GitHub
 * issues are PRDs, failures are run-internal, and the authoritative per-task status
 * already lives in the run state. Failures-only content — each block names the failure
 * class, the human reason, and the task's FULL acceptance criteria (all unmet,
 * because a failure never cleared the merge gate). The leading marker makes a re-finalize
 * idempotent (see {@link failureCommentMarker}).
 */
export function renderFailureComment(report: PartialRunReport): string {
  const lines: string[] = [
    failureCommentMarker(report.run_id),
    `Factory run \`${report.run_id}\` failed — ${report.failures.length} task(s) failed. ` +
      `PRD left open for rescue/resume.`,
  ];
  if (report.e2e_failure !== undefined) {
    const { plain, detail } = splitReason(report.e2e_failure);
    lines.push("", "### End-to-end verification failed", plain);
    if (detail !== undefined) lines.push("```", detail, "```");
  }
  if (report.e2e_assessment_failure !== undefined) {
    const { plain, detail } = splitReason(report.e2e_assessment_failure);
    lines.push("", "### End-to-end setup failed before any task ran", plain);
    if (detail !== undefined) lines.push("```", detail, "```");
  }
  for (const failure of report.failures) {
    lines.push("", `### \`${failure.task_id}\` — ${failure.title}`);
    lines.push(`- **Class:** \`${failure.failure_class}\``);
    lines.push(`- **Reason:** ${failure.failure_reason}`);
    if (failure.branch !== undefined) lines.push(`- **Branch:** \`${failure.branch}\``);
    if (failure.pr_number !== undefined) lines.push(`- **PR:** #${failure.pr_number}`);
    lines.push("- **Unmet acceptance criteria:**");
    for (const c of failure.unmet_criteria) lines.push(`  - [ ] ${c}`);
  }
  return lines.join("\n");
}

/** A short uppercase label for a run status, for report headers. */
function statusLabel(status: RunStatus): string {
  return status.toUpperCase();
}

/**
 * Render the report as a markdown document. Used as the rollup-PR body and the
 * summary surface. Sections that are empty for the run's outcome are omitted
 * (a `completed` run shows no Failed/Incomplete section).
 */
export function renderPartialReportMarkdown(report: PartialRunReport): string {
  const out: string[] = [];
  out.push(`# Factory run report — \`${report.run_id}\``);
  out.push("");
  out.push(
    `**Status:** ${statusLabel(report.run_status)} · ` +
      `**Spec:** \`${report.spec_id}\` (PRD #${report.issue_number}) · ` +
      `**Repo:** ${report.repo}`,
  );
  out.push(`**Generated:** ${report.generated_at}`);
  out.push("");
  out.push(
    `**Tasks:** ${report.totals.total} total · ${report.totals.shipped} shipped · ` +
      `${report.totals.failed} failed · ${report.totals.incomplete} incomplete`,
  );
  out.push("");

  out.push(`## Shipped (${report.shipped.length})`);
  if (report.shipped.length === 0) {
    out.push("_none_");
  } else {
    for (const s of report.shipped) {
      const pr = s.pr_number !== undefined ? ` — PR #${s.pr_number}` : "";
      const br = s.branch !== undefined ? ` (\`${s.branch}\`)` : "";
      out.push(`- \`${s.task_id}\` — ${s.title}${pr}${br}`);
    }
  }
  out.push("");

  if (report.e2e_journeys !== undefined) {
    out.push(`## End-to-end journeys verified (${report.e2e_journeys.length})`);
    for (const j of report.e2e_journeys) out.push(`- ${j}`);
    out.push("");
  }

  if (report.e2e_reopened !== undefined) {
    out.push("## Found by end-to-end testing");
    out.push(
      `The e2e suite caught failing journeys and sent ${report.e2e_reopened.length} task(s) ` +
        `back for fixes: ${report.e2e_reopened.map((id) => `\`${id}\``).join(", ")}`,
    );
    out.push("");
  }

  if (report.e2e_warnings !== undefined) {
    out.push("## End-to-end warnings");
    for (const w of report.e2e_warnings) out.push(`- ${w}`);
    out.push("");
  }

  if (report.cross_vendor_absences !== undefined) {
    out.push("## Review independence");
    out.push(
      `${report.cross_vendor_absences.length} task(s) were reviewed WITHOUT an ` +
        `independent second-vendor reviewer:`,
    );
    for (const a of report.cross_vendor_absences) {
      out.push(`- \`${a.task_id}\` — ${a.reason}`);
    }
    out.push("");
  }

  if (report.e2e_assessment_failure !== undefined) {
    const { plain, detail } = splitReason(report.e2e_assessment_failure);
    out.push("## End-to-end setup failed before any task ran");
    out.push(plain);
    if (detail !== undefined) out.push("```", detail, "```");
    out.push("");
  }

  if (report.e2e_failure !== undefined) {
    const { plain, detail } = splitReason(report.e2e_failure);
    out.push("## End-to-end verification failed");
    out.push(plain);
    if (detail !== undefined) out.push("```", detail, "```");
    out.push("");
  }

  if (report.e2e_advisory !== undefined) {
    out.push("## End-to-end verification — advisory");
    out.push(report.e2e_advisory);
    out.push("");
  }

  if (report.failures.length > 0) {
    out.push(`## Failed (${report.failures.length})`);
    for (const f of report.failures) {
      out.push("");
      out.push(`### \`${f.task_id}\` — ${f.title}`);
      out.push(`- **Class:** \`${f.failure_class}\``);
      out.push(`- **Reason:** ${f.failure_reason}`);
      out.push("- **Unmet acceptance criteria:**");
      for (const c of f.unmet_criteria) out.push(`  - ${c}`);
    }
    out.push("");
  }

  if (report.incomplete.length > 0) {
    out.push(`## Incomplete (${report.incomplete.length})`);
    for (const i of report.incomplete) {
      out.push(`- \`${i.task_id}\` — ${i.title} (\`${i.status}\`)`);
    }
    out.push("");
  }

  return out.join("\n");
}
