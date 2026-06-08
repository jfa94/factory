/**
 * WS10 / Task C — the SHARED deterministic task-transition logic.
 *
 * This is the one home for the per-task ladder + drop/complete logic that BOTH
 * drivers need:
 *   - the in-process {@link import("./loop.js").driveTask} loop (the v1 session
 *     "Balanced"/"Sequential" presets + the v2 Workflow driver), and
 *   - the `factory record-producer` / `record-reviews` / `drop` CLI subcommands
 *     (the orchestrator-sequenced single-step path — Task C).
 *
 * Both must apply the IDENTICAL escalation ladder (Δ D / Decision 25): a classified
 * retry bumps `escalation_rung` and clears the stale reviewers (so the next verify
 * re-derives fresh), capped at {@link ESCALATION_CAP}; an unrecoverable failure is a
 * classified LOUD drop. Keeping it here (not duplicated in the CLI) guarantees the
 * session-CLI path and the in-process loop can never diverge — the existing loop
 * test-suite is the regression guard for this extraction.
 *
 * SCOPE: these functions own ONLY run-state mutations + the resulting next-step
 * intent ({@link TaskStep}). They never spawn agents, never run gates, and never do
 * git I/O — that is the reporter's / loop's / subcommand's job. Each takes the
 * narrow {@link TransitionDeps} (just the {@link StateManager}), so the CLI (which
 * has no agent runners) reuses them verbatim.
 */
import {
  classifyFailure,
  ESCALATION_CAP,
  stageToInFlightStatus,
  assertNever,
  type ClassifyDecision,
  type FailureClass,
  type ProducerOutcome,
  type ProducerRole,
  type StateManager,
  type TaskStage,
} from "./deps.js";
import { nowIso, createLogger } from "../shared/index.js";

const log = createLogger("transitions");

/** The narrow dependency the transitions need: only the state write path. */
export interface TransitionDeps {
  readonly state: StateManager;
}

/** A terminal task outcome (mirrors the WS2 TaskTerminalResult.outcome shape). */
export type TaskOutcome =
  | { readonly outcome: "done" }
  | { readonly outcome: "dropped"; readonly failure_class: FailureClass; readonly reason: string };

/** One step of the per-task loop: keep going at `stage`, or stop with an outcome. */
export type TaskStep =
  | { readonly done: false; readonly stage: TaskStage }
  | { readonly done: true; readonly outcome: TaskOutcome };

/**
 * Persist the in-flight {@link import("./deps.js").TaskStatus} for `stage`,
 * stamping `started_at` on first entry. The in-process loop calls this at the top
 * of each iteration; the CLI record subcommands call it after a transition that
 * resumes at a stage, so the persisted status tracks the resume point.
 */
export async function markInFlight(
  deps: TransitionDeps,
  runId: string,
  taskId: string,
  stage: TaskStage,
): Promise<void> {
  const status = stageToInFlightStatus(stage);
  await deps.state.updateTask(runId, taskId, (t) => ({
    ...t,
    status,
    started_at: t.started_at ?? nowIso(),
  }));
}

/** Persist a task as `done` (stamping ended_at once) and end the loop. */
export async function completeTask(
  deps: TransitionDeps,
  runId: string,
  taskId: string,
): Promise<TaskStep> {
  await deps.state.updateTask(runId, taskId, (t) => ({
    ...t,
    status: "done",
    ended_at: t.ended_at ?? nowIso(),
  }));
  return { done: true, outcome: { outcome: "done" } };
}

/**
 * Persist the closed {@link FailureClass} + reason on a dropped task (the WS1
 * "failure_class/failure_reason set IFF dropped" invariant; both required, reason
 * non-empty). A loud drop, never a silent done.
 */
export async function dropTask(
  deps: TransitionDeps,
  runId: string,
  taskId: string,
  failureClass: FailureClass,
  reason: string,
): Promise<void> {
  log.warn(`task '${taskId}' dropped (${failureClass}): ${reason}`);
  await deps.state.updateTask(runId, taskId, (t) => ({
    ...t,
    status: "dropped",
    failure_class: failureClass,
    failure_reason: reason,
    ended_at: t.ended_at ?? nowIso(),
  }));
}

/** Persist a classified drop and end the loop with the dropped outcome. */
export async function dropStep(
  deps: TransitionDeps,
  runId: string,
  taskId: string,
  failureClass: FailureClass,
  reason: string,
): Promise<TaskStep> {
  await dropTask(deps, runId, taskId, failureClass, reason);
  return { done: true, outcome: { outcome: "dropped", failure_class: failureClass, reason } };
}

/**
 * Apply a classified retry-or-drop decision (Δ D). A `drop` is an immediate
 * classified loud drop. A `retry` bumps the escalation rung (clearing the stale
 * reviewers so the next verify re-derives fresh) and resumes at `resumeStage` —
 * UNLESS the rung budget is exhausted, in which case it drops `capability-budget`
 * (the ladder, not the classifier, owns the cap).
 *
 * Note: this persists only the DOMAIN state (rung + reviewers); the in-flight
 * status for `resumeStage` is the caller's concern (the loop re-marks it next
 * iteration; the CLI calls {@link markInFlight} after).
 */
export async function escalateOrDrop(
  deps: TransitionDeps,
  runId: string,
  taskId: string,
  decision: ClassifyDecision,
  resumeStage: TaskStage,
): Promise<TaskStep> {
  if (decision.action === "drop") {
    return dropStep(deps, runId, taskId, decision.failureClass, decision.reason);
  }
  const run = await deps.state.read(runId);
  const task = run.tasks[taskId];
  if (task === undefined) {
    throw new Error(`transitions: task '${taskId}' vanished from run '${runId}'`);
  }
  if (task.escalation_rung >= ESCALATION_CAP) {
    return dropStep(
      deps,
      runId,
      taskId,
      "capability-budget",
      `producer escalation cap (${ESCALATION_CAP}) reached without clearing the floor: ${decision.reason}`,
    );
  }
  const nextRung = task.escalation_rung + 1;
  await deps.state.updateTask(runId, taskId, (t) => ({
    ...t,
    escalation_rung: nextRung,
    reviewers: [],
  }));
  log.info(
    `task '${taskId}' escalating to rung ${nextRung}; resuming at '${resumeStage}' (${decision.reason})`,
  );
  return { done: false, stage: resumeStage };
}

/** Map a non-`done` {@link ProducerOutcome} to a classify decision (Δ D). */
export function classifyProducerFailure(outcome: ProducerOutcome): ClassifyDecision {
  switch (outcome.status) {
    case "blocked-escalate":
      return classifyFailure({
        kind: "producer-status",
        status: "blocked-escalate",
        reason: outcome.reason,
      });
    case "needs-context":
      return classifyFailure({
        kind: "producer-status",
        status: "needs-context",
        reason: outcome.reason,
      });
    case "error":
      return classifyFailure({ kind: "producer-status", status: "error", reason: outcome.reason });
    case "done":
      throw new Error("transitions: classifyProducerFailure called on a 'done' outcome");
    default:
      return assertNever(outcome);
  }
}

/**
 * Act on a completed producer spawn (the actSpawn-post logic shared by the loop +
 * `factory record-producer`). On `done`: record `producer_role` and advance to
 * `stageAfter`. On any failure status: classify (Δ D) → {@link escalateOrDrop},
 * resuming at the SAME producer `stage`.
 *
 * The caller is responsible for the actual spawn (the loop via the injected
 * runner; the CLI via the orchestrator's Agent spawn) — this only folds the
 * resulting {@link ProducerOutcome} into state + the next step.
 */
export async function applyProducerOutcome(
  deps: TransitionDeps,
  runId: string,
  taskId: string,
  opts: { readonly role: ProducerRole; readonly stage: TaskStage; readonly stageAfter: TaskStage },
  outcome: ProducerOutcome,
): Promise<TaskStep> {
  if (outcome.status === "done") {
    await deps.state.updateTask(runId, taskId, (t) => ({ ...t, producer_role: opts.role }));
    return { done: false, stage: opts.stageAfter };
  }
  return escalateOrDrop(deps, runId, taskId, classifyProducerFailure(outcome), opts.stage);
}
