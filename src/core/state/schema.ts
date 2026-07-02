/**
 * WS1 — Typed `RunState` / `TaskState` schema (Zod). THE FROZEN STATE SEAM.
 *
 * Downstream workstreams (WS2 phase-machine, WS3 git, WS4 quota, WS5 spec,
 * WS6/7 verifier, WS8 producer, WS9 hooks, WS10 orchestrators, WS12 scoring) import
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
 *   - run status `partial` — incremental delivery is retired (Decision 34): a run
 *     either delivers the whole PRD (`completed`) or leaves `develop` untouched
 *     (`failed`). `paused` / `suspended` remain DISTINCT quota states (Δ E).
 *   - the two-classifier model (`classify` + `risk` + `risk_tier`) — collapsed to
 *     ONE `risk_tier` producer dial (Decision 25, Δ "review-depth axis deleted").
 *   - stored gate-verdict booleans (`quality_gate.ok`, `mutation_gate`, …) —
 *     verdicts are DERIVED, never stored (Δ V); see derive.ts. This schema
 *     deliberately has NO field that holds a gate pass/fail boolean.
 */
import { z } from "zod";
import { TASK_PHASES, SPAWN_PHASES } from "../../types/phases-vocab.js";

// ---------------------------------------------------------------------------
// Closed enums (the seam's vocabulary)
// ---------------------------------------------------------------------------

/**
 * Run-level status. The non-`running` states are the crux of Δ E — they must
 * stay distinct:
 *
 *   - `running`    — actively executing (non-terminal).
 *   - `completed`  — every task done, rollup CI green. TERMINAL, success.
 *                    `develop` receives the rollup only on this status.
 *   - `superseded` — a fresh `run` superseded this run; its `staging-<run-id>`
 *                    branch + PRs were deleted. TERMINAL.
 *   - `paused`     — QUOTA 5h-window breach (Decision 24): waiting out the rising
 *                    threshold curve in-session. NON-terminal, self-heals.
 *   - `suspended`  — QUOTA 7d-window breach (Decision 24): state persisted and the
 *                    process exited cleanly. NON-terminal; a (human-relaunched in
 *                    v1) `factory run resume` continues from checkpoint. No work
 *                    was failed, nothing failed quality.
 *   - `failed`     — the run could not deliver the whole PRD — couldn't start, or
 *                    gave up after partial work; `develop` is untouched, the PRD
 *                    left open. TERMINAL.
 *
 * Terminal = {completed, superseded, failed}. Non-terminal = {running, paused,
 * suspended}. {@link isTerminalRunStatus} is the single source of that split.
 */
export const RunStatusEnum = z.enum([
  "running",
  "completed",
  "superseded",
  "paused",
  "suspended",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatusEnum>;

/** Run statuses that are TERMINAL (no further work will run without a new run). */
export const TERMINAL_RUN_STATUSES = ["completed", "failed", "superseded"] as const;
/** Run statuses that are NON-terminal (work may yet continue / resume). */
export const NONTERMINAL_RUN_STATUSES = ["running", "paused", "suspended"] as const;

/** True iff the run status is terminal. The one authority for the split. */
export function isTerminalRunStatus(s: RunStatus): s is (typeof TERMINAL_RUN_STATUSES)[number] {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(s);
}

/**
 * Task-level status. Closed set; human-gate statuses are gone.
 *   - `pending`    — not yet started (or blocked on an unsatisfied dependency).
 *   - `executing`  — a producer (test-writer / implementer) phase is in flight.
 *   - `reviewing`  — the merge gate (gates + panel) is in flight.
 *   - `shipping`   — verified; PR open / merging into staging.
 *   - `done`       — merged into staging (TERMINAL, success).
 *   - `failed`    — the producer escalation ladder was exhausted; this task is a
 *                    classified loud fail (Decision 22). TERMINAL, failure. Pairs
 *                    with a {@link FailureClassEnum} value in `failure_class`.
 */
export const TaskStatusEnum = z.enum([
  "pending",
  "executing",
  "reviewing",
  "shipping",
  "done",
  "failed",
]);
export type TaskStatus = z.infer<typeof TaskStatusEnum>;

/** Task statuses that are TERMINAL. */
export const TERMINAL_TASK_STATUSES = ["done", "failed"] as const;
/** True iff the task status is terminal. */
export function isTerminalTaskStatus(s: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(s);
}

/**
 * CLOSED failure-class enum (Decision 22, Δ D). When a task is `failed` the
 * fail is *classified* so the partial-run report tells the human what to do.
 * This is a small, deliberately-final set — adding a class is a design change,
 * not a config tweak.
 *   - `capability-budget`     — the producer could not meet the bar within the
 *                               escalation ladder's retry/model budget.
 *   - `spec-defect`           — the failure is in the spec/target itself (e.g. an
 *                               untestable criterion, a contradiction). Classify-
 *                               before-retry (Δ D) sends these straight to fail.
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
 * Risk tier — the SINGLE producer dial (Decision 25). It records difficulty ×
 * stakes into one spec-time judgment and sets the STARTING rung of the producer
 * escalation ladder. It does NOT size the verifier (the merge gate is risk-invariant,
 * Decision 26) and there is no separate review-depth axis.
 */
export const RiskTierEnum = z.enum(["low", "medium", "high"]);
export type RiskTier = z.infer<typeof RiskTierEnum>;

/**
 * Escalation rung — where on the producer ladder the task currently sits
 * (Decision 25). Rung 0 = the starting rung implied by the risk tier; each
 * nuke-and-retry bumps it. The ladder cap (`ESCALATION_CAP` = 4 extra attempts) is
 * enforced by the orchestrator (`src/orchestrator/transitions.ts` escalateOrFail), not the
 * schema; the schema only records the rung reached so a resume continues from the
 * right place. Non-negative integer.
 */
export const EscalationRungSchema = z.number().int().min(0);

/**
 * Panel verdict — one independent reviewer's outcome (Decision 26/27). The panel
 * verdict is conjunctive: the task clears only on unanimous `approve`. `blocked`
 * carries findings that — after the verify-then-fix confirmation (Decision 27) —
 * return the task to the producer. `error` is a reviewer that failed to produce a
 * usable verdict (LOUD, never silently treated as approve).
 */
export const PanelVerdictEnum = z.enum(["approve", "blocked", "error"]);
export type PanelVerdict = z.infer<typeof PanelVerdictEnum>;

/** Producer sub-phase a task may be in (test-writer first, then implementer). */
export const ProducerRoleEnum = z.enum(["test-writer", "implementer"]);
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
 * thing is the *merge-gate* verdict (unanimity), computed in derive.ts.
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
 * One fix-forward instruction carried into the NEXT producer rung after a
 * merge-gate block (D5 fix-forward channel). A lean LOCAL shape — deliberately
 * NOT the verifier's `Finding` type: this module is the frozen state seam other
 * layers import FROM (never the reverse), so importing a verifier type here would
 * invert that dependency. `record.ts` maps confirmed reviewer blockers and
 * non-holdout failing gate evidence into this shape before persisting.
 */
export const FixFindingSchema = z
  .object({
    /** Origin of the finding: a reviewer name (e.g. "security") or a gate id (e.g. "lint"). */
    reviewer: z.string().min(1),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    description: z.string().min(1),
  })
  .superRefine((finding, ctx) => {
    // Mirrors the T4 both-or-neither rule on the verifier's FindingSchema
    // (src/verifier/judgment/finding.ts): a half-citation would reach the next
    // producer rung as an unlocatable instruction.
    const hasFile = finding.file !== undefined;
    const hasLine = finding.line !== undefined;
    if (hasFile && !hasLine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["line"],
        message: `finding has 'file' but no 'line' — provide both or neither for a citable finding`,
      });
    }
    if (hasLine && !hasFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["file"],
        message: `finding has 'line' but no 'file' — provide both or neither for a citable finding`,
      });
    }
  });
export type FixFinding = z.infer<typeof FixFindingSchema>;

/**
 * Per-task state. Carries the producer ladder position, the panel results, the
 * git/PR pointers, and the failure classification — but NO stored gate-verdict
 * booleans, and NO producer dial: the `risk_tier` dial is read live from the spec
 * via `specTaskOf`, never copied here (derive-don't-store, Decision 25). A gate's
 * pass/fail is always re-derived (derive.ts) from ground truth, so there is
 * structurally nothing here to forge (Δ V).
 */
export const TaskStateSchema = z.object({
  task_id: z.string().min(1),
  status: TaskStatusEnum.default("pending"),
  /**
   * Task ids this task depends on (the vertical-slice DAG, Decision 23). A
   * deliberate denormalization: copied from the {@link SpecTask} at seed time and
   * then frozen (never mutated), so the hot DAG-traversal readers — `next.ts`
   * (ready-task selection) and `rescue/scan.ts` (drift scan, which has NO spec in
   * scope) — read edges straight off run state without coupling to the spec store.
   * Integrity is pinned at seed time by `seedTasksFromSpec`, where dangling, self,
   * cyclic, and duplicate edges all fail LOUD.
   */
  depends_on: z.array(z.string()).default([]),

  // --- Producer ladder (Decision 25; the risk_tier dial lives on the SpecTask, not here) ---
  /** Current rung on the producer escalation ladder (0 = starting rung). */
  escalation_rung: EscalationRungSchema.default(0),
  /** Which producer role is/last ran. */
  producer_role: ProducerRoleEnum.optional(),
  /**
   * Defect feedback carried from the implementer's `test-defective` escalation into
   * the NEXT test-writer re-run (the test-revision recovery, Δ D). Set when the
   * implementer reports the RED test is wrong; injected into the regenerated
   * test-writer's prior-failure context (handlers.tests) so it does not re-pin the
   * same wrong literal; cleared once the test-writer returns `done`. Absent
   * otherwise. Transient — not a failure field (allowed on any status).
   */
  test_revision_feedback: z.string().optional(),

  /**
   * Feedback carried from a failing e2e journey spec into this task's NEXT
   * implementation pass (the e2e reopen loop, Decision 39). Set by the e2e coroutine
   * when it maps a failing spec to this task via the author manifest and resets the
   * task to `pending`; injected into the regenerated producer's prior-failure context
   * (mirrors `test_revision_feedback`, but originates from a RUN-LEVEL phase, not a
   * per-task producer outcome). Cleared once the task ships again. Absent otherwise.
   * Transient — not a failure field (allowed on any status).
   */
  e2e_feedback: z.string().optional(),

  /**
   * Fix-forward instructions carried from a blocked merge-gate verify into the
   * NEXT producer (`exec`) rung (D5 fix-forward channel). Composed at the
   * wait-retry branch (`record.ts`) from confirmed reviewer blockers ∪ non-holdout
   * failing gate evidence, persisted BEFORE `escalateOrFail` clears `reviewers`
   * (mirrors the `test_revision_feedback` precedent: a separate write ahead of the
   * ladder transition). `handlers.ts`'s `exec` reads it into `buildProducerContext`
   * as `confirmedBlockers`. Cleared on the next advance/complete. Absent otherwise.
   * Transient — not a failure field (allowed on any status).
   */
  fix_findings: z.array(FixFindingSchema).optional(),

  // --- Merge gate (Decision 26/27) ---
  /** Per-reviewer panel results (derive.ts computes the merge-gate verdict from these). */
  reviewers: z.array(ReviewerResultSchema).default([]),

  // --- Git / PR pointers (WS3 populates; schema reserves the shape) ---
  /** Run-scoped branch `factory/<run_id>/<task_id>` (Δ M). */
  branch: z.string().optional(),
  /** PR number once created (idempotent-create keyed off branch, Δ P). */
  pr_number: z.number().int().positive().optional(),

  // --- Failure classification (Decision 22, Δ D) ---
  /** Set IFF status === "failed": the closed-enum cause. */
  failure_class: FailureClassEnum.optional(),
  /** Human-facing reason string accompanying a fail. */
  failure_reason: z.string().optional(),

  /**
   * The precise resume cursor for the drive orchestrator — which TaskPhase the task is
   * at/resuming at. Written by markInFlight. Lossy `status` stays the human-facing
   * summary; `phase` is the machine cursor. Absent = not started (preflight).
   * NOTE: on terminal rows (done/failed), `phase` is the last in-flight phase,
   * not a resume point — terminal writers do not clear it.
   * NOTE: both this enum and phase-machine's TASK_PHASE_ORDER import the SAME
   * literal tuple from `types/phases-vocab.ts` (the dependency-free vocabulary
   * leaf), so they cannot drift; the cross-check test in
   * src/orchestrator/orchestrator.test.ts is belt-and-braces, not load-bearing.
   */
  phase: z.enum(TASK_PHASES).optional(),
  /** Ship live-merge re-sync count (cap enforced by the orchestrator; persisted so the cap survives process boundaries). */
  merge_resyncs: z.number().int().min(0).default(0),

  /**
   * Spawn-in-flight checkpoint (idempotent re-spawn). Set by the orchestrator when it
   * EMITS a spawn for `phase` at `rung`, recording the task-branch `tip_sha` at emit
   * time. Producers commit to the SHARED task worktree, so a stop in the post-spawn /
   * pre-record window leaves the abandoned producer's partial commits on the branch. On
   * the resume that re-enters the SAME (phase, rung) before any results were recorded,
   * the orchestrator resets the worktree to `tip_sha` — discarding ONLY the interrupted
   * phase's work (prior completed phases live below it) — then re-spawns. A fresh
   * spawn overwrites it; terminal writers (complete/fail) clear it. Absent = no spawn
   * in flight (the steady state between phases).
   *
   * `phase` is the spawn-phase subset (tests|exec|verify) — preflight/ship never spawn.
   * Both this enum and orchestrator/results' SPAWN_PHASES import the same tuple from
   * `types/phases-vocab.ts`, so they cannot drift (the orchestrator.test.ts cross-check
   * is belt-and-braces, mirroring the `phase` field's pin).
   */
  spawn_in_flight: z
    .object({
      phase: z.enum(SPAWN_PHASES),
      rung: z.number().int().min(0),
      tip_sha: z.string().min(1),
    })
    .optional(),

  // --- Lifecycle timestamps (ISO-8601) ---
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
});
export type TaskState = z.infer<typeof TaskStateSchema>;

/**
 * Cross-field invariant (Decision 22, Δ D): a fail MUST be classified, and a
 * failure_class is meaningless on any non-failed status — "set IFF failed".
 * Applied at parse time (see {@link parseTaskState} / {@link parseRunState}) so
 * the exported {@link TaskStateSchema} stays a plain object — keeps `.shape` /
 * `.extend` for downstream — while every sanctioned parse still rejects the
 * invalid shapes. Lets WS2/WS12 non-null-assert failure_class on a failed task
 * and never encounter it on a done one.
 */
function refineTaskCrossFields(task: TaskState, ctx: z.RefinementCtx): void {
  const isFailed = task.status === "failed";
  if (isFailed && task.failure_class == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure_class"],
      message: `task '${task.task_id}' is 'failed' but has no failure_class (a fail must be classified)`,
    });
  }
  if (!isFailed && task.failure_class != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure_class"],
      message: `task '${task.task_id}' has failure_class '${task.failure_class}' but status is '${task.status}' (failure_class is set IFF failed)`,
    });
  }

  // `failure_reason` is set IFF failed, mirroring failure_class — TaskTerminalResult's
  // failed variant makes `reason: string` MANDATORY, so the persisted twin must too
  // (Decision 22: a fail carries the human-facing reason for the partial-run report).
  const hasReason = task.failure_reason != null && task.failure_reason.length > 0;
  if (isFailed && !hasReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure_reason"],
      message: `task '${task.task_id}' is 'failed' but has no failure_reason (a fail must carry a human-facing reason)`,
    });
  }
  if (!isFailed && task.failure_reason != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure_reason"],
      message: `task '${task.task_id}' has a failure_reason but status is '${task.status}' (failure_reason is set IFF failed)`,
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

  // T3 defense-in-depth: spawn_in_flight.rung must never EXCEED escalation_rung.
  // A forward gap (spawn_in_flight.rung < escalation_rung) is a valid transient
  // state — the escalation bumped the rung and the next spawn will overwrite the
  // checkpoint. A backward gap (spawn_in_flight.rung > escalation_rung) is
  // impossible in the normal state machine (rung only increases) and indicates an
  // improper backward reset like the G2 bug (resetTaskRow resetting escalation_rung
  // to 0 without clearing spawn_in_flight). The primary fix is rescue/apply.ts
  // clearing the field; this invariant catches any future regression at parse time.
  if (task.spawn_in_flight !== undefined && task.spawn_in_flight.rung > task.escalation_rung) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["spawn_in_flight", "rung"],
      message: `task '${task.task_id}' spawn_in_flight.rung (${task.spawn_in_flight.rung}) > escalation_rung (${task.escalation_rung}) — rung went backward, stale checkpoint from before a rescue reset`,
    });
  }
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
// Docs phase marker (engine-owned documentation phase)
// ---------------------------------------------------------------------------

/**
 * Run-level documentation phase marker (engine-owned docs phase). `done` once
 * scribe's output is committed onto staging (or a no-op pass); `failed` records a
 * one-attempt failure while the run sits `suspended` (resumable via /factory:resume).
 * Absent until the phase runs. Not applicable (no /docs, opted out) leaves it absent —
 * `next` decides applicability read-only, so there is no `skipped` value.
 */
export const DocsPhaseSchema = z.object({
  status: z.enum(["done", "failed"]),
  reason: z.string().optional(),
  /** Cumulative attempt count (1-indexed). Absent on legacy records — treat as 1. */
  attempts: z.number().int().nonnegative().optional(),
  ended_at: z.string(),
});
export type DocsPhase = z.infer<typeof DocsPhaseSchema>;

// ---------------------------------------------------------------------------
// E2E phase marker + author manifest (engine-owned e2e phase, Decision 39)
// ---------------------------------------------------------------------------

/**
 * Criticality by PERSISTENCE, not tags (Decision 39). `critical` specs are
 * committed to the target repo's `e2e/` (proven via the fail-first proof, gate
 * the run + CI); `throwaway` specs live only in the run's ephemeral out-of-repo
 * dir (advisory, discarded at run end). Nothing is annotated inside the spec file
 * itself — this enum only labels a manifest row, it is never written into the
 * Playwright test source.
 */
export const E2eSpecKindEnum = z.enum(["critical", "throwaway"]);
export type E2eSpecKind = z.infer<typeof E2eSpecKindEnum>;

/**
 * One author-emitted manifest row — the spec→task link (Decision 39: a manifest,
 * not Playwright tags/annotations and not git provenance, since squash-merges
 * destroy commit→task history at both task→staging and staging→develop). Fixed at
 * authoring time; the e2e coroutine joins a failing spec back to its task(s)
 * purely through this array, never through source inspection.
 */
export const E2eManifestEntrySchema = z.object({
  /** Task id(s) this spec exercises (a critical journey spec may span >1 task). */
  task_ids: z.array(z.string().min(1)).min(1),
  /** Spec file path — repo-relative for `critical`, run-ephemeral-dir-relative for `throwaway`. */
  spec_path: z.string().min(1),
  kind: E2eSpecKindEnum,
});
export type E2eManifestEntry = z.infer<typeof E2eManifestEntrySchema>;

/**
 * Run-level e2e phase marker + author manifest (engine-owned e2e phase, ordered
 * BEFORE docs). Unlike {@link DocsPhaseSchema} — written once and never
 * re-entered — this object's `status` is CLEARED (set back to absent) on every
 * reopen so `wantsE2e()` re-fires the phase once the reopened task settles, while
 * `manifest` and `reopen_counts` PERSIST across the clear: the author is not
 * re-invoked on later passes (throwaway specs are re-run, not re-authored) and the
 * per-task reopen cap holds across the whole run, not just one pass.
 *   - `status` absent  — phase not yet run this pass, or cleared for a reopen re-fire.
 *   - `status` "done"  — every critical spec is green; the run proceeds to docs.
 *   - `status` "failed"— run FAILS: residual critical red, an unmappable critical
 *                        regression, or a cap-exhausted critical (Decision 39).
 */
export const E2ePhaseSchema = z.object({
  status: z.enum(["done", "failed"]).optional(),
  reason: z.string().optional(),
  /**
   * Non-gating note surfaced on a `done` phase — e.g. residual THROWAWAY red that
   * didn't block completion (Decision 9: only critical red gates). Distinct from
   * `reason`, which the T2 cross-field check reserves for `failed` (set IFF
   * failed) — `advisory` is the `done`-side counterpart, never present on `failed`.
   */
  advisory: z.string().optional(),
  /** Cumulative attempt count across ALL passes (1-indexed). */
  attempts: z.number().int().nonnegative().optional(),
  /** The author's spec→task manifest, fixed once authored and reused across passes. */
  manifest: z.array(E2eManifestEntrySchema).default([]),
  /** Per-task reopen count so far, keyed by task_id — bounds each task by `e2e.reopenCap`. */
  reopen_counts: z.record(z.string(), z.number().int().nonnegative()).default({}),
  ended_at: z.string().optional(),
});
export type E2ePhase = z.infer<typeof E2ePhaseSchema>;

// ---------------------------------------------------------------------------
// RunState
// ---------------------------------------------------------------------------

/** The execution-mode preset that produced this run (Sequential/Balanced). */
export const ExecutionModeEnum = z.enum(["sequential", "balanced"]);
export type ExecutionMode = z.infer<typeof ExecutionModeEnum>;

/**
 * Execution mode (Decision 24). `session` runs in the runner's live
 * session and can observe the usage cache → fully paced. `workflow` runs as a
 * background Workflow script that cannot observe usage → quota pacing is
 * disabled (the run hard-stops on rate-limit errors; the user is warned at
 * opt-in). An immutable run property set once at `run create`, never a derived
 * verdict; the quota gate skips pacing when it is `workflow`.
 */
export const RunModeEnum = z.enum(["session", "workflow"]);
export type RunMode = z.infer<typeof RunModeEnum>;

/**
 * Ship mode for the run's rollup. `live` (the DEFAULT) auto-merges each task into
 * staging and serial-merges the staging→develop rollup — the pipeline's purpose,
 * gated by branch protection + the review panel + TDD + the holdout. `no-merge`
 * (the `--no-ship` opt-out) opens the rollup PR but never merges. An immutable run
 * property set once at `run create` (from the absence/presence of `--no-ship`) —
 * persisted so the workflow runner, `resume`, and `finalize` read it from the run
 * (the source of truth) instead of re-marshaling it through fragile Workflow `args`
 * or re-prompting the user. Mirrors {@link RunModeEnum}: a stored property, never a
 * derived verdict.
 */
export const ShipModeEnum = z.enum(["no-merge", "live"]);
export type ShipMode = z.infer<typeof ShipModeEnum>;

/**
 * The whole run. Owns the per-task state map + the spec POINTER (not the spec).
 * `schema_version` is a state-schema version for forward migration; bump only on a
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
  schema_version: z.literal(2).default(2),
  /** `run-YYYYMMDD-HHMMSS`. */
  run_id: z.string().min(1),
  status: RunStatusEnum.default("running"),
  execution_mode: ExecutionModeEnum.default("sequential"),
  mode: RunModeEnum.default("session"),
  ship_mode: ShipModeEnum.default("live"),

  /**
   * The Claude Code session id that OWNS this run (Prompt J — session-scoped Stop
   * gate). Stamped ONCE at `run create` from the launching session's
   * `CLAUDE_CODE_SESSION_ID` (the runner/Bash env), so the Stop hook can
   * session-scope its block: only the OWNING session is gated; an unrelated session
   * stopping while this run is live passes through. Optional — best-effort: when the
   * env var is absent (owner unknown), the Stop gate falls back to the unscoped
   * behavior (degraded but safe). An immutable property, never a derived verdict.
   */
  owner_session: z.string().min(1).optional(),

  /**
   * The per-run staging branch this run cut + pushed (`staging-<run-id>`). PINNED
   * ONCE at `run create` (Decision 33) so every later base-ref resolution — worktree
   * fork point, deterministic-gate diff base, reviewer/holdout inspect ref, ship
   * merge target, rollup source — reads the branch the run ACTUALLY created, not a
   * value recomputed by `runStagingBranch(run_id)`. A mid-run naming-scheme change
   * (e.g. the slashed→flat rename) would otherwise silently desync the recompute from
   * the already-pushed branch. Optional for backward-compat: legacy runs predating the
   * pin lack it; readers fall back to `runStagingBranch(run_id)` via `resolveStagingBranch`.
   * Git provenance / immutable identity — NOT a derived verdict, so derive-don't-store
   * does not apply.
   */
  staging_branch: z.string().min(1).optional(),

  /** Pointer to the durable spec (Δ X) — NOT an embedded spec. */
  spec: SpecPointerSchema,

  /** Per-task state, keyed by task_id (cross-field checks applied per task). */
  tasks: z.record(z.string(), TaskStateChecked).default({}),

  /**
   * When true, the quota gate skips pacing and returns null unconditionally. Set once at
   * `run create` from `--ignore-quota`, or toggled true by `factory resume --ignore-quota`.
   * Persisted so both orchestrators and both runners skip the gate without per-call flag
   * threading — mirrors the `mode==="workflow"` skip. Default false: legacy runs (no field)
   * are unaffected.
   */
  ignore_quota: z.boolean().default(false),

  /** Quota resume checkpoint (Decision 24); absent until a pause/suspend. */
  quota: QuotaCheckpointSchema.optional(),

  /** Documentation phase marker; absent until the docs phase runs (engine docs phase). */
  docs: DocsPhaseSchema.optional(),

  /**
   * Whether this run opted into the e2e phase (the `--e2e` flag). Set once at
   * `run create`; immutable for the run's lifetime — mirrors `ignore_quota`.
   * Default false: a run without the flag never gates on `wantsE2e()`.
   */
  e2e: z.boolean().default(false),

  /** E2E phase marker + author manifest; absent until the e2e phase first runs. */
  e2e_phase: E2ePhaseSchema.optional(),

  /**
   * The `completed` run's staging→develop rollup outcome, persisted at finalize
   * (finalize.ts step 7) ONLY when it did not land (`merged:false` — e.g. the
   * "auto-armed" branch-policy fallback, D3). Absent on a merged rollup (nothing
   * to recover) or a `failed` run (no rollup attempted). Lets `rescue scan` flag
   * an armed-but-not-landed rollup (`rollup_pending`) without a live GitHub call —
   * minimal-surface recovery: `rescue apply --recheck-rollup` reopens the run so a
   * re-drive re-enters `finalizeRun`, whose rollup() resume-guard finds the
   * now-merged PR and completes the PRD-close + branch-GC.
   */
  rollup: z
    .object({
      number: z.number().int().positive(),
      merged: z.boolean(),
      reason: z.string().optional(),
    })
    .optional(),

  /**
   * Whether this run is a `/factory:debug` session. Set once at `run create`;
   * immutable for the run's lifetime — mirrors `e2e`/`ignore_quota`. A `debug:true`
   * run loops through multiple review⇄fix passes before finalizing, so it defers
   * `run finalize` (the PRD comment/close) to the debug driver instead of the plain
   * runner loop, and the Stop gate skips even its resumability hint for it. Default
   * false: a run without the flag finalizes exactly as before.
   */
  debug: z.boolean().default(false),

  /**
   * Cumulative minutes the run spent idle between suspend/pause and resume/rescue-reopen.
   * Accumulated on each resume or rescue-reopen so the runtime circuit-breaker can deduct
   * real pause time from wall-time, preventing a false trip on a long-paused run. Default
   * 0 — absent on legacy runs (pre-Group-2-E records) → treated as 0 (no regression).
   */
  paused_minutes: z.number().nonnegative().default(0),

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
/** Shared "reason set IFF failed" phase check (T1 docs / T2 e2e below). */
function reasonIffFailed(
  ctx: z.RefinementCtx,
  opts: {
    runId: string;
    path: readonly string[];
    label: string;
    status: string;
    reason: string | null | undefined;
  },
): void {
  const isFailed = opts.status === "failed";
  const hasReason = opts.reason != null && opts.reason.length > 0;
  if (isFailed && !hasReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...opts.path],
      message: `run '${opts.runId}' ${opts.label} is 'failed' but has no reason`,
    });
  }
  if (!isFailed && hasReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...opts.path],
      message: `run '${opts.runId}' ${opts.label} is '${opts.status}' but carries a reason (reason is set IFF failed)`,
    });
  }
}

function refineRunCrossFields(run: RunState, ctx: z.RefinementCtx): void {
  const quotaStatuses: readonly RunStatus[] = ["paused", "suspended"];
  if (run.quota != null && !quotaStatuses.includes(run.status)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["quota"],
      message: `run '${run.run_id}' carries a quota checkpoint but status is '${run.status}' (a quota checkpoint is valid only while paused|suspended)`,
    });
  }

  // Terminal ⇔ ended: a terminal run must carry ended_at, and a live one must not —
  // every terminal write sets it and rescue's reopen resets it to null, so a mismatch
  // is a serialization bug (e.g. a status flip that skipped the timestamp).
  if (isTerminalRunStatus(run.status) !== (run.ended_at != null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ended_at"],
      message: isTerminalRunStatus(run.status)
        ? `run '${run.run_id}' is terminal ('${run.status}') but has no ended_at`
        : `run '${run.run_id}' is '${run.status}' (non-terminal) but carries ended_at`,
    });
  }

  // T1: DocsPhase "reason set IFF failed" — mirrors the TaskState failure_reason
  // invariant (refineTaskCrossFields above). A failed docs phase must carry a reason
  // (human-facing report); a reason on a done docs phase is a serialization smell.
  if (run.docs !== undefined) {
    reasonIffFailed(ctx, {
      runId: run.run_id,
      path: ["docs", "reason"],
      label: "docs phase",
      status: run.docs.status,
      reason: run.docs.reason,
    });
  }

  // T2: E2ePhase "reason set IFF failed" — mirrors the DocsPhase check above. Unlike
  // docs, `status` may also be legitimately ABSENT (pending, or cleared for a reopen
  // re-fire) — a reason is meaningless then too, so the check only fires when status
  // is present.
  if (run.e2e_phase !== undefined && run.e2e_phase.status !== undefined) {
    const isFailed = run.e2e_phase.status === "failed";
    reasonIffFailed(ctx, {
      runId: run.run_id,
      path: ["e2e_phase", "reason"],
      label: "e2e phase",
      status: run.e2e_phase.status,
      reason: run.e2e_phase.reason,
    });

    // `advisory` is the done-side counterpart of `reason` (see E2ePhaseSchema's own
    // doc comment) — never present on `failed`.
    const hasAdvisory = run.e2e_phase.advisory != null && run.e2e_phase.advisory.length > 0;
    if (isFailed && hasAdvisory) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["e2e_phase", "advisory"],
        message: `run '${run.run_id}' e2e phase is 'failed' but carries an advisory (advisory is the done-side counterpart of reason, never set on failed)`,
      });
    }
  }

  // F2: tasks map key must equal the row's task_id so DAG traversal and keyed lookups
  // always agree. A key/id mismatch is a serialization bug — reject at parse time.
  for (const [k, value] of Object.entries(run.tasks)) {
    if (k !== value.task_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tasks", k, "task_id"],
        message: `tasks map key '${k}' does not match row task_id '${value.task_id}'`,
      });
    }
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
 * "failure_class set IFF failed" cross-field invariant. Prefer this over
 * `TaskStateSchema.parse`.
 */
export function parseTaskState(raw: unknown): TaskState {
  return TaskStateChecked.parse(raw);
}
