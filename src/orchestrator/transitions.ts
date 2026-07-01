/**
 * WS10 — the SHARED deterministic task-transition logic.
 *
 * This is the one home for the per-task escalation ladder + fail/complete logic
 * the engine builds on: the per-task orchestrator ({@link import("./orchestrator.js").nextAction})
 * acts on a live phase result through these, and the record cores
 * ({@link import("./record.js")}) record an out-of-band agent result through the same
 * functions. Keeping the ladder here (not duplicated across the spawn path and the
 * record path) guarantees a crash-resume record and a live step can never diverge.
 *
 * Both must apply the IDENTICAL escalation ladder (Δ D / Decision 25): a classified
 * retry bumps `escalation_rung` and clears the stale reviewers (so the next verify
 * re-derives fresh), capped at {@link ESCALATION_CAP}; an unrecoverable failure is a
 * classified LOUD fail.
 *
 * SCOPE: these functions own ONLY run-state mutations + the resulting next-step
 * intent ({@link TaskStep}). They never spawn agents, never run gates, and never do
 * git I/O — that is the reporter's / orchestrator's job. Each takes the narrow
 * {@link TransitionDeps} (just the {@link StateManager}).
 */
import {
  classifyFailure,
  ESCALATION_CAP,
  phaseToInFlightStatus,
  type ClassifyDecision,
  type FailureClass,
  type ProducerOutcome,
  type ProducerRole,
  type RunState,
  type StateManager,
  type TaskPhase,
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
  | { readonly outcome: "failed"; readonly failure_class: FailureClass; readonly reason: string };

/** One step of the per-task loop: keep going at `phase`, or stop with an outcome. */
export type TaskStep =
  | { readonly done: false; readonly phase: TaskPhase }
  | { readonly done: true; readonly outcome: TaskOutcome };

/**
 * Persist the in-flight {@link import("./deps.js").TaskStatus} for `phase`,
 * stamping `started_at` on first entry. The orchestrator calls this when it needs the
 * cursor written for a phase it is about to run; the record paths call it (via
 * persistStepCursor) after a transition that resumes at a phase, so the persisted
 * status tracks the resume point.
 *
 * RETURNS the updated {@link RunState} (from the single locked `updateTask` write)
 * so the orchestrator can consume it directly instead of issuing a redundant `state.read`
 * — discarding callers (persistStepCursor) ignore it safely.
 */
export function markInFlight(
  deps: TransitionDeps,
  runId: string,
  taskId: string,
  phase: TaskPhase,
): Promise<RunState> {
  const status = phaseToInFlightStatus(phase);
  return deps.state.updateTask(runId, taskId, (t) => ({
    ...t,
    status,
    phase,
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
    // Decision 39: an e2e reopen's feedback is cleared once the task ships again —
    // the schema's own field comment ("cleared once the task ships again").
    e2e_feedback: undefined,
  }));
  return { done: true, outcome: { outcome: "done" } };
}

/**
 * Persist the closed {@link FailureClass} + reason on a failed task (the WS1
 * "failure_class/failure_reason set IFF failed" invariant; both required, reason
 * non-empty). A loud fail, never a silent done.
 */
export async function failTask(
  deps: TransitionDeps,
  runId: string,
  taskId: string,
  failureClass: FailureClass,
  reason: string,
): Promise<void> {
  log.warn(`task '${taskId}' failed (${failureClass}): ${reason}`);
  await deps.state.updateTask(runId, taskId, (t) => ({
    ...t,
    status: "failed",
    failure_class: failureClass,
    failure_reason: reason,
    ended_at: t.ended_at ?? nowIso(),
    spawn_in_flight: undefined, // WS2 hygiene: no spawn is in flight past a terminal task
  }));
}

/** Persist a classified failure and end the loop with the failed outcome. */
export async function failStep(
  deps: TransitionDeps,
  runId: string,
  taskId: string,
  failureClass: FailureClass,
  reason: string,
): Promise<TaskStep> {
  await failTask(deps, runId, taskId, failureClass, reason);
  return { done: true, outcome: { outcome: "failed", failure_class: failureClass, reason } };
}

/**
 * Apply a classified retry-or-fail decision (Δ D). A `fail` is an immediate
 * classified loud fail. A `retry` bumps the escalation rung (clearing the stale
 * reviewers so the next verify re-derives fresh) and resumes at `resumePhase` —
 * UNLESS the rung budget is exhausted, in which case it fails `capability-budget`
 * (the ladder, not the classifier, owns the cap).
 *
 * Note: this persists only the DOMAIN state (rung + reviewers); the in-flight
 * status for `resumePhase` is the caller's concern (the orchestrator re-marks it via
 * {@link markInFlight} next iteration; the record path stamps it via
 * persistStepCursor).
 */
export async function escalateOrFail(
  deps: TransitionDeps,
  runId: string,
  taskId: string,
  decision: ClassifyDecision,
  resumePhase: TaskPhase,
): Promise<TaskStep> {
  if (decision.action === "fail") {
    return failStep(deps, runId, taskId, decision.failureClass, decision.reason);
  }
  const run = await deps.state.read(runId);
  const task = run.tasks[taskId];
  if (task === undefined) {
    throw new Error(`transitions: task '${taskId}' vanished from run '${runId}'`);
  }
  if (task.escalation_rung >= ESCALATION_CAP) {
    return failStep(
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
    `task '${taskId}' escalating to rung ${nextRung}; resuming at '${resumePhase}' (${decision.reason})`,
  );
  return { done: false, phase: resumePhase };
}

/** Map a non-`done` {@link ProducerOutcome} to a classify decision (Δ D). */
export function classifyProducerFailure(outcome: ProducerOutcome): ClassifyDecision {
  if (outcome.status === "done") {
    throw new Error("transitions: classifyProducerFailure called on a 'done' outcome");
  }
  return classifyFailure({
    kind: "producer-status",
    status: outcome.status,
    reason: outcome.reason,
  });
}

/**
 * Record a completed producer spawn into state (the producer-result logic the orchestrator's
 * `applyRecordProducer` record core calls). On `done`: record `producer_role` and
 * advance to `resumePhase` (clearing any pending test-revision feedback on a
 * test-writer done). On `test-defective` from the implementer (`exec` phase): persist
 * the defect feedback and recover by resuming at the `tests` phase so the test-writer
 * regenerates. A `test-defective` from any other role is nonsensical (the parser is
 * role-blind) — classify as a producer `error` so the ladder records and caps it
 * instead of escaping `next-action`'s catch. On any other failure status: classify
 * (Δ D) → {@link escalateOrFail}, resuming at the SAME producer `phase`.
 *
 * The caller is responsible for the actual spawn (the runner's Agent spawn,
 * collected out-of-band) — this only records the resulting {@link ProducerOutcome}
 * into state + the next step.
 */
export async function applyProducerOutcome(
  deps: TransitionDeps,
  runId: string,
  taskId: string,
  opts: { readonly role: ProducerRole; readonly phase: TaskPhase; readonly resumePhase: TaskPhase },
  outcome: ProducerOutcome,
): Promise<TaskStep> {
  if (outcome.status === "done") {
    await deps.state.updateTask(runId, taskId, (t) => ({
      ...t,
      producer_role: opts.role,
      // A completed test-writer re-run resolves any pending defect feedback — clear
      // it so a stale note never leaks into a later rung's regeneration.
      ...(opts.role === "test-writer" ? { test_revision_feedback: undefined } : {}),
    }));
    return { done: false, phase: opts.resumePhase };
  }
  // A `test-defective` escalation (only the implementer raises it) recovers by
  // RE-RUNNING THE TEST-WRITER: persist the defect feedback and resume at `tests`
  // (not the implementer's own `exec` phase). The escalation cap still bounds it.
  if (outcome.status === "test-defective") {
    if (opts.phase !== "exec") {
      // The parser is role-blind, so a non-exec role can emit 'test-defective'.
      // That signal is nonsensical for the role: classify as a producer error so
      // the ladder records + caps it instead of escaping next-action's catch.
      return escalateOrFail(
        deps,
        runId,
        taskId,
        classifyFailure({
          kind: "producer-status",
          status: "error",
          reason: `'test-defective' from non-exec role '${opts.role}': ${outcome.reason}`,
        }),
        opts.phase,
      );
    }
    await deps.state.updateTask(runId, taskId, (t) => ({
      ...t,
      test_revision_feedback: outcome.reason,
    }));
    return escalateOrFail(deps, runId, taskId, classifyProducerFailure(outcome), "tests");
  }
  return escalateOrFail(deps, runId, taskId, classifyProducerFailure(outcome), opts.phase);
}
