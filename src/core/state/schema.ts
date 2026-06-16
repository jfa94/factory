/**
 * WS1 — Typed `RunState` / `TaskState` schema (Zod). THE FROZEN STATE SEAM.
 *
 * Downstream workstreams (WS2 stage-machine, WS3 git, WS4 quota, WS5 spec,
 * WS6/7 verifier, WS8 producer, WS9 hooks, WS10 drivers, WS12 scoring) import
 * these types and enums and MUST NOT redefine them. Every enum here is a CLOSED
 * set: a value outside the set is a LOUD parse error, never a silent pass — this
 * is the structural property the bash `_validate_task_field_value` guard tried to
 * approximate by hand at each write site.
 *
 * Design source: plan §"State storage model" + Decisions 7/22/24/25/26/27 and the
 * delta-ledger rows E (run-status semantics), V (derive-don't-store), X (spec
 * keyed by (repo, spec-id), not run-id), D (closed failure-class enum).
 *
 * GREENFIELD: the bash `state.json` shape (bin/pipeline-init, bin/pipeline-state
 * field lists) is consulted for *what data a run needs*, never copied verbatim.
 * Retired-by-decision concepts are deliberately ABSENT and must not be ported:
 *   - run status `interrupted`, task status `needs_human_review`, the `ci_fixing`
 *     ad-hoc status, `humanReviewLevel` / `NEEDS_DISCUSSION` — human gates are
 *     retired (locked decision 5).
 *   - the old conflation of `partial` (quality) with quota states (Δ E) — here
 *     `partial` / `paused` / `suspended` are DISTINCT run-status values.
 *   - the two-classifier model (`classify` + `risk` + `risk_tier`) — collapsed to
 *     ONE `risk_tier` producer dial (Decision 25, Δ "review-depth axis deleted").
 *   - stored gate-verdict booleans (`quality_gate.ok`, `mutation_gate`, …) —
 *     verdicts are DERIVED, never stored (Δ V); see derive.ts. This schema
 *     deliberately has NO field that holds a gate pass/fail boolean.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Closed enums (the seam's vocabulary)
// ---------------------------------------------------------------------------

/**
 * Run-level status. The three NON-`running` non-terminal-vs-terminal states are
 * the crux of Δ E — they must stay distinct:
 *
 *   - `running`    — actively executing (non-terminal).
 *   - `completed`  — every task done, rollup CI green (TERMINAL, success).
 *   - `partial`    — QUALITY outcome (Decision 22): the retry ladder was
 *                    exhausted on ≥1 task; the dependency-closed done-set shipped
 *                    to `develop`, the failed task(s) handed off loudly. TERMINAL,
 *                    a run-level FAILURE. Never used for a quota event.
 *   - `paused`     — QUOTA 5h-window breach (Decision 24): waiting out the rising
 *                    threshold curve in-session. NON-terminal, self-heals.
 *   - `suspended`  — QUOTA 7d-window breach (Decision 24): state persisted and the
 *                    process exited cleanly. NON-terminal; a (human-relaunched in
 *                    v1) `factory run resume` continues from checkpoint. Distinct
 *                    from `partial`: no work was dropped, nothing failed quality.
 *   - `failed`     — the run could not even start / a non-recoverable run-level
 *                    error before any partial delivery is possible (TERMINAL).
 *
 * Terminal = {completed, partial, failed}. Non-terminal = {running, paused,
 * suspended}. {@link isTerminalRunStatus} is the single source of that split.
 */
export const RunStatusEnum = z.enum([
  "running",
  "completed",
  "partial",
  "paused",
  "suspended",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatusEnum>;

/** Run statuses that are TERMINAL (no further work will run without a new run). */
export const TERMINAL_RUN_STATUSES = ["completed", "partial", "failed"] as const;
/** Run statuses that are NON-terminal (work may yet continue / resume). */
export const NONTERMINAL_RUN_STATUSES = ["running", "paused", "suspended"] as const;

/** True iff the run status is terminal. The one authority for the split. */
export function isTerminalRunStatus(s: RunStatus): s is (typeof TERMINAL_RUN_STATUSES)[number] {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(s);
}

/**
 * Task-level status. Closed set; human-gate statuses are gone.
 *   - `pending`    — not yet started (or blocked on an unsatisfied dependency).
 *   - `executing`  — a producer (test-writer / executor) stage is in flight.
 *   - `reviewing`  — the verifier floor (gates + panel) is in flight.
 *   - `shipping`   — verified; PR open / merging into staging.
 *   - `done`       — merged into staging (TERMINAL, success).
 *   - `dropped`    — the producer escalation ladder was exhausted; this task is a
 *                    classified loud drop (Decision 22). TERMINAL, failure. Pairs
 *                    with a {@link FailureClassEnum} value in `failure_class`.
 */
export const TaskStatusEnum = z.enum([
  "pending",
  "executing",
  "reviewing",
  "shipping",
  "done",
  "dropped",
]);
export type TaskStatus = z.infer<typeof TaskStatusEnum>;

/** Task statuses that are TERMINAL. */
export const TERMINAL_TASK_STATUSES = ["done", "dropped"] as const;
/** True iff the task status is terminal. */
export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(s);
}

/**
 * CLOSED failure-class enum (Decision 22, Δ D). When a task is `dropped` the
 * drop is *classified* so the partial-run report tells the human what to do.
 * This is a small, deliberately-final set — adding a class is a design change,
 * not a config tweak.
 *   - `capability-budget`     — the producer could not meet the bar within the
 *                               escalation ladder's retry/model budget.
 *   - `spec-defect`           — the failure is in the spec/target itself (e.g. an
 *                               untestable criterion, a contradiction). Classify-
 *                               before-retry (Δ D) sends these straight to drop.
 *   - `blocked-environmental` — an external blocker (CI infra, network, a missing
 *                               dependency the task cannot itself provision).
 */
export const FailureClassEnum = z.enum([
  "capability-budget",
  "spec-defect",
  "blocked-environmental",
]);
export type FailureClass = z.infer<typeof FailureClassEnum>;

/**
 * Risk tier — the SINGLE producer dial (Decision 25). It folds difficulty ×
 * stakes into one spec-time judgment and sets the STARTING rung of the producer
 * escalation ladder. It does NOT size the verifier (the floor is risk-invariant,
 * Decision 26) and there is no separate review-depth axis.
 */
export const RiskTierEnum = z.enum(["low", "medium", "high"]);
export type RiskTier = z.infer<typeof RiskTierEnum>;

/**
 * Escalation rung — where on the producer ladder the task currently sits
 * (Decision 25). Rung 0 = the starting rung implied by the risk tier; each
 * nuke-and-retry bumps it. The ladder cap (Δ "cap = 2 extra attempts") is
 * enforced by WS8, not the schema; the schema only records the rung reached so
 * a resume continues from the right place. Non-negative integer.
 */
export const EscalationRungSchema = z.number().int().min(0);

/**
 * Panel verdict — one independent reviewer's outcome (Decision 26/27). The panel
 * floor is conjunctive: the task clears only on unanimous `approve`. `blocked`
 * carries findings that — after the verify-then-fix confirmation (Decision 27) —
 * return the task to the producer. `error` is a reviewer that failed to produce a
 * usable verdict (LOUD, never silently treated as approve).
 */
export const PanelVerdictEnum = z.enum(["approve", "blocked", "error"]);
export type PanelVerdict = z.infer<typeof PanelVerdictEnum>;

/** Producer sub-stage a task may be in (test-writer first, then executor). */
export const ProducerRoleEnum = z.enum(["test-writer", "executor"]);
export type ProducerRole = z.infer<typeof ProducerRoleEnum>;

// ---------------------------------------------------------------------------
// Spec pointer (Δ X — a run points at a spec; it does NOT embed one)
// ---------------------------------------------------------------------------

/**
 * A run's pointer to its spec. The spec itself lives in the DURABLE per-spec
 * store `specs/<repo>/<spec-id>/` (WS5 owns its content); a run records only this
 * pointer (Δ X). `spec_id = "<issue>-<slug>"` where the issue number is the
 * stable lookup key (reruns resolve the same spec) and the slug is human-readable
 * (named by the spec generator). Both `repo` and `spec_id` are required — a run
 * without a resolvable spec is invalid.
 *
 * NOTE: `repo` here is the addressing key for the spec store path (e.g.
 * "owner/name"); it is sanitized to a path segment by the store, not stored as a
 * filesystem path.
 */
export const SpecPointerSchema = z.object({
  /** Repo identity, e.g. "owner/name". The first key of (repo, spec-id). */
  repo: z.string().min(1),
  /** `<issue>-<slug>`. The second key of (repo, spec-id). */
  spec_id: z.string().min(1),
  /** The PRD issue number — the STABLE lookup key embedded in spec_id. */
  issue_number: z.number().int().positive(),
});
export type SpecPointer = z.infer<typeof SpecPointerSchema>;

// ---------------------------------------------------------------------------
// TaskState
// ---------------------------------------------------------------------------

/**
 * One reviewer's recorded panel result. Holds the artifact pointer + the
 * post-verify-then-fix verdict, NOT a trusted "this gate passed" boolean for any
 * DETERMINISTIC gate (those are derived, Δ V). A panel verdict is itself the
 * ground truth of a judgment reviewer's opinion, so it is stored; the DERIVED
 * thing is the *floor* verdict (unanimity), computed in derive.ts.
 */
export const ReviewerResultSchema = z.object({
  /** Reviewer identity (e.g. "implementation", "security", "silent-failure"). */
  reviewer: z.string().min(1),
  /** This reviewer's verdict after verify-then-fix adjudication. */
  verdict: PanelVerdictEnum,
  /** Pointer to the review artifact (relative to the run's reviews/ dir). */
  artifact: z.string().optional(),
  /** Number of confirmed (verified) blocking findings this reviewer raised. */
  confirmed_blockers: z.number().int().min(0).default(0),
});
export type ReviewerResult = z.infer<typeof ReviewerResultSchema>;

/**
 * Per-task state. Carries the producer dial + ladder, the panel results, the
 * git/PR pointers, and the failure classification — but NO stored gate-verdict
 * booleans. A gate's pass/fail is always re-derived (derive.ts) from ground
 * truth, so there is structurally nothing here to forge (Δ V).
 */
export const TaskStateSchema = z.object({
  task_id: z.string().min(1),
  status: TaskStatusEnum.default("pending"),
  /** Task ids this task depends on (the vertical-slice DAG, Decision 23). */
  depends_on: z.array(z.string()).default([]),

  // --- Producer dial + ladder (Decision 25) ---
  /** The single producer dial, set at spec time and never re-assessed mid-run. */
  risk_tier: RiskTierEnum,
  /** Current rung on the producer escalation ladder (0 = starting rung). */
  escalation_rung: EscalationRungSchema.default(0),
  /** Which producer role is/last ran. */
  producer_role: ProducerRoleEnum.optional(),

  // --- Verifier floor (Decision 26/27) ---
  /** Per-reviewer panel results (derive.ts computes the floor verdict from these). */
  reviewers: z.array(ReviewerResultSchema).default([]),

  // --- Git / PR pointers (WS3 populates; schema reserves the shape) ---
  /** Run-scoped branch `factory/<run_id>/<task_id>` (Δ M). */
  branch: z.string().optional(),
  /** PR number once created (idempotent-create keyed off branch, Δ P). */
  pr_number: z.number().int().positive().optional(),

  // --- Drop classification (Decision 22, Δ D) ---
  /** Set IFF status === "dropped": the closed-enum cause. */
  failure_class: FailureClassEnum.optional(),
  /** Human-facing reason string accompanying a drop. */
  failure_reason: z.string().optional(),

  /**
   * The precise resume cursor for the drive coroutine — which TaskStage the task is
   * at/resuming at. Written by markInFlight. Lossy `status` stays the human-facing
   * summary; `stage` is the machine cursor. Absent = not started (preflight).
   * NOTE: on terminal rows (done/dropped), `stage` is the last in-flight stage,
   * not a resume point — terminal writers do not clear it.
   * NOTE: literals duplicate stage-machine's TASK_STAGE_ORDER because core/state
   * must not import stage-machine (dependency direction) — a cross-check test in
   * src/driver/coroutine.test.ts pins them equal.
   */
  stage: z.enum(["preflight", "tests", "exec", "verify", "ship"]).optional(),
  /** Ship live-merge re-sync count (cap enforced by the coroutine; persisted so the cap survives process boundaries). */
  merge_resyncs: z.number().int().min(0).default(0),

  // --- Lifecycle timestamps (ISO-8601) ---
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
});
export type TaskState = z.infer<typeof TaskStateSchema>;

/**
 * Cross-field invariant (Decision 22, Δ D): a drop MUST be classified, and a
 * failure_class is meaningless on any non-dropped status — "set IFF dropped".
 * Applied at parse time (see {@link parseTaskState} / {@link parseRunState}) so
 * the exported {@link TaskStateSchema} stays a plain object — keeps `.shape` /
 * `.extend` for downstream — while every sanctioned parse still rejects the
 * invalid shapes. Lets WS2/WS12 non-null-assert failure_class on a dropped task
 * and never encounter it on a done one.
 */
function refineTaskCrossFields(task: TaskState, ctx: z.RefinementCtx): void {
  const isDropped = task.status === "dropped";
  if (isDropped && task.failure_class == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure_class"],
      message: `task '${task.task_id}' is 'dropped' but has no failure_class (a drop must be classified)`,
    });
  }
  if (!isDropped && task.failure_class != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure_class"],
      message: `task '${task.task_id}' has failure_class '${task.failure_class}' but status is '${task.status}' (failure_class is set IFF dropped)`,
    });
  }

  // `failure_reason` is set IFF dropped, mirroring failure_class — TaskTerminalResult's
  // dropped variant makes `reason: string` MANDATORY, so the persisted twin must too
  // (Decision 22: a drop carries the human-facing reason for the partial-run report).
  const hasReason = task.failure_reason != null && task.failure_reason.length > 0;
  if (isDropped && !hasReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure_reason"],
      message: `task '${task.task_id}' is 'dropped' but has no failure_reason (a drop must carry a human-facing reason)`,
    });
  }
  if (!isDropped && task.failure_reason != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure_reason"],
      message: `task '${task.task_id}' has a failure_reason but status is '${task.status}' (failure_reason is set IFF dropped)`,
    });
  }

  // Panel-verdict / blocker-count coherence (Decision 26/27): a stored reviewer
  // result is post-verify-then-fix, so an `approve` must record 0 confirmed
  // blockers and a `blocked` must record ≥1 — otherwise the audit trail
  // derivePanelVerdict surfaces is self-contradictory. `error` is unconstrained.
  task.reviewers.forEach((r, i) => {
    if (r.verdict === "approve" && r.confirmed_blockers !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewers", i, "confirmed_blockers"],
        message: `reviewer '${r.reviewer}' approves but records ${r.confirmed_blockers} confirmed blocker(s) (approve ⇒ 0)`,
      });
    }
    if (r.verdict === "blocked" && r.confirmed_blockers === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewers", i, "confirmed_blockers"],
        message: `reviewer '${r.reviewer}' is blocked but records 0 confirmed blockers (blocked ⇒ ≥1)`,
      });
    }
  });
}

/** {@link TaskStateSchema} + cross-field checks — the validating form the seam parses. */
const TaskStateChecked = TaskStateSchema.superRefine(refineTaskCrossFields);

// ---------------------------------------------------------------------------
// Quota checkpoint (WS4 owns the policy; schema reserves the persisted shape so
// a suspended run resumes from the right place — Decision 24)
// ---------------------------------------------------------------------------

/**
 * The minimal quota state a resumable run must persist. WS4 extends/owns the
 * pacing logic; the schema only freezes what `suspended`/`paused` resume needs.
 */
export const QuotaCheckpointSchema = z.object({
  /** Epoch (seconds) when the binding window resets — the resume horizon. */
  resets_at_epoch: z.number().int().nonnegative().optional(),
  /** Which window forced the last pause/suspend, if any. */
  binding_window: z.enum(["5h", "7d"]).optional(),
});
export type QuotaCheckpoint = z.infer<typeof QuotaCheckpointSchema>;

// ---------------------------------------------------------------------------
// RunState
// ---------------------------------------------------------------------------

/** The orchestrator driver preset that produced this run (Sequential/Balanced). */
export const DriverEnum = z.enum(["sequential", "balanced"]);
export type Driver = z.infer<typeof DriverEnum>;

/**
 * Execution mode (Decision 24). `session` runs in the orchestrator's live
 * session and can observe the usage cache → fully paced. `workflow` runs as a
 * background Workflow script that cannot observe usage → quota pacing is
 * disabled (the run hard-stops on rate-limit errors; the user is warned at
 * opt-in). An immutable run property set once at `run create`, never a derived
 * verdict; the quota gate skips pacing when it is `workflow`.
 */
export const RunModeEnum = z.enum(["session", "workflow"]);
export type RunMode = z.infer<typeof RunModeEnum>;

/**
 * Ship mode for the run's rollup. `no-merge` opens the staging→develop rollup PR
 * but never merges (cutover-safe default); `live` serial-merges into staging. An
 * immutable run property set once at `run create` from `--ship-mode` — persisted
 * so the `--mode workflow` driver and `resume` read it from the run (the source
 * of truth) instead of re-marshaling it through fragile Workflow `args` or
 * re-prompting the user. Mirrors {@link RunModeEnum}: a stored property, never a
 * derived verdict.
 */
export const ShipModeEnum = z.enum(["no-merge", "live"]);

/**
 * The whole run. Owns the per-task state map + the spec POINTER (not the spec).
 * `version` is a state-schema version for forward migration; bump only on a
 * breaking schema change.
 *
 * ⚠️ For persisted-state validation, call {@link parseRunState}, NOT
 * `RunStateSchema.parse` directly. The exported object stays a plain `z.object`
 * (so downstream keeps `.shape` / `.extend`), which means a raw `.parse` runs the
 * per-TASK cross-field check (tasks use `TaskStateChecked`) but SKIPS the run-level
 * quota invariant (a `quota` checkpoint allowed only while paused|suspended).
 * `parseRunState` layers that check on. Use this schema directly only to derive a
 * shape (`.shape`/`.extend`); use `parseRunState` to validate untrusted input.
 */
export const RunStateSchema = z.object({
  /** State-schema version (independent of plugin version). */
  schema_version: z.literal(1).default(1),
  /** `run-YYYYMMDD-HHMMSS`. */
  run_id: z.string().min(1),
  status: RunStatusEnum.default("running"),
  driver: DriverEnum.default("sequential"),
  mode: RunModeEnum.default("session"),
  ship_mode: ShipModeEnum.default("no-merge"),

  /** Pointer to the durable spec (Δ X) — NOT an embedded spec. */
  spec: SpecPointerSchema,

  /** Per-task state, keyed by task_id (cross-field checks applied per task). */
  tasks: z.record(z.string(), TaskStateChecked).default({}),

  /** Quota resume checkpoint (Decision 24); absent until a pause/suspend. */
  quota: QuotaCheckpointSchema.optional(),

  /** Lifecycle timestamps (ISO-8601). */
  started_at: z.string(),
  updated_at: z.string(),
  ended_at: z.string().nullable().default(null),
});
export type RunState = z.infer<typeof RunStateSchema>;

/**
 * Run-level cross-field invariant (Decision 24): a quota checkpoint records the
 * resume horizon for a QUOTA pause/suspend, so it may only be present while the
 * run is `paused` or `suspended`. Resume MUST clear it before returning to
 * `running`; a terminal run never carries one. Applied at parse time.
 */
function refineRunCrossFields(run: RunState, ctx: z.RefinementCtx): void {
  const quotaStatuses: readonly RunStatus[] = ["paused", "suspended"];
  if (run.quota != null && !quotaStatuses.includes(run.status)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["quota"],
      message: `run '${run.run_id}' carries a quota checkpoint but status is '${run.status}' (a quota checkpoint is valid only while paused|suspended)`,
    });
  }
}

/** {@link RunStateSchema} + run-level cross-field checks — the validating form the seam parses. */
const RunStateChecked = RunStateSchema.superRefine(refineRunCrossFields);

/**
 * Parse + validate an unknown value as a {@link RunState}. LOUD on any closed-enum
 * violation, missing required field, or cross-field invariant breach (ZodError) —
 * this is the structural guard that replaces the hand-written bash enum checks.
 * Prefer this over `RunStateSchema.parse` (this also runs the cross-field checks).
 */
export function parseRunState(raw: unknown): RunState {
  return RunStateChecked.parse(raw);
}

/**
 * Parse + validate an unknown value as a {@link TaskState}, including the
 * "failure_class set IFF dropped" cross-field invariant. Prefer this over
 * `TaskStateSchema.parse`.
 */
export function parseTaskState(raw: unknown): TaskState {
  return TaskStateChecked.parse(raw);
}
