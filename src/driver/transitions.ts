/**
 * WS10 — the SHARED deterministic task-transition logic.
 *
 * This is the one home for the per-task escalation ladder + drop/complete logic
 * the engine builds on: the per-task coroutine ({@link import("./coroutine.js").stepTask})
 * acts on a live stage result through these, and the fold cores
 * ({@link import("./fold.js")}) fold an out-of-band agent result through the same
 * functions. Keeping the ladder here (not duplicated across the spawn path and the
 * fold path) guarantees a crash-resume fold and a live step can never diverge.
 *
 * Both must apply the IDENTICAL escalation ladder (Δ D / Decision 25): a classified
 * retry bumps `escalation_rung` and clears the stale reviewers (so the next verify
 * re-derives fresh), capped at {@link ESCALATION_CAP}; an unrecoverable failure is a
 * classified LOUD drop.
 *
 * SCOPE: these functions own ONLY run-state mutations + the resulting next-step
 * intent ({@link TaskStep}). They never spawn agents, never run gates, and never do
 * git I/O — that is the reporter's / coroutine's job. Each takes the narrow
 * {@link TransitionDeps} (just the {@link StateManager}).
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
  type RunState,
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
 * stamping `started_at` on first entry. The coroutine calls this when it needs the
 * cursor written for a stage it is about to run; the fold paths call it (via
 * persistStepCursor) after a transition that resumes at a stage, so the persisted
 * status tracks the resume point.
 *
 * RETURNS the updated {@link RunState} (from the single locked `updateTask` write)
 * so the coroutine can consume it directly instead of issuing a redundant `state.read`
 * — discarding callers (persistStepCursor) ignore it safely.
 */
export function markInFlight(
  deps: TransitionDeps,
  runId: string,
  taskId: string,
  stage: TaskStage,
): Promise<RunState> {
  const status = stageToInFlightStatus(stage);
  return deps.state.updateTask(runId, taskId, (t) => ({
    ...t,
    status,
    stage,
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
    spawn_in_flight: undefined, // WS2 hygiene: no spawn is in flight past a terminal task
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
    spawn_in_flight: undefined, // WS2 hygiene: no spawn is in flight past a terminal task
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
 * status for `resumeStage` is the caller's concern (the coroutine re-marks it via
 * {@link markInFlight} next iteration; the fold path stamps it via
 * persistStepCursor).
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
      `producer escalation cap (${ESCALATION_CAP}) reached without clearing the merge gate: ${decision.reason}`,
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
 * Fold a completed producer spawn into state (the producer-result logic the coroutine's
 * `applyRecordProducer` fold core calls). On `done`: record `producer_role` and
 * advance to `stageAfter`. On any failure status: classify (Δ D) →
 * {@link escalateOrDrop}, resuming at the SAME producer `stage`.
 *
 * The caller is responsible for the actual spawn (the orchestrator's Agent spawn,
 * collected out-of-band) — this only folds the resulting {@link ProducerOutcome}
 * into state + the next step.
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
