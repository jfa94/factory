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
    doneTaskRow,
    ESCALATION_CAP,
    phaseToInFlightStatus,
    type ClassifyDecision,
    type FailureClass,
    type ProducerOutcome,
    type ProducerRole,
    type RunState,
    type StateManager,
    type TaskPhase,
} from './deps.js'
import {nowIso, createLogger} from '../shared/index.js'

const log = createLogger('transitions')

/** The narrow dependency the transitions need: only the state write path. */
export interface TransitionDeps {
    readonly state: StateManager
}

/** A terminal task outcome (mirrors the WS2 TaskTerminalResult.outcome shape). */
export type TaskOutcome =
    | {readonly outcome: 'done'}
    | {readonly outcome: 'failed'; readonly failure_class: FailureClass; readonly reason: string}

/** One step of the per-task loop: keep going at `phase`, or stop with an outcome. */
export type TaskStep =
    | {readonly done: false; readonly phase: TaskPhase}
    | {readonly done: true; readonly outcome: TaskOutcome}

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
export function markInFlight(deps: TransitionDeps, runId: string, taskId: string, phase: TaskPhase): Promise<RunState> {
    const status = phaseToInFlightStatus(phase)
    return deps.state.updateTask(runId, taskId, (t) => ({
        ...t,
        status,
        phase,
        started_at: t.started_at ?? nowIso(),
    }))
}

/**
 * Persist a task as `done` (stamping ended_at once) and end the loop. Delegates the
 * row shape to {@link doneTaskRow} (shared with rescue adoption, Decision 60) so
 * "what shipping a task clears" — spawn_in_flight, the e2e reopen feedback, a stale
 * fix-forward record — has ONE source of truth across the live ship + adopt paths.
 */
export async function completeTask(deps: TransitionDeps, runId: string, taskId: string): Promise<TaskStep> {
    await deps.state.updateTask(runId, taskId, (t) => doneTaskRow(t, nowIso()))
    return {done: true, outcome: {outcome: 'done'}}
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
    reason: string
): Promise<void> {
    log.warn(`task '${taskId}' failed (${failureClass}): ${reason}`)
    await deps.state.updateTask(runId, taskId, (t) => ({
        ...t,
        status: 'failed',
        failure_class: failureClass,
        failure_reason: reason,
        ended_at: t.ended_at ?? nowIso(),
        spawn_in_flight: undefined, // WS2 hygiene: no spawn is in flight past a terminal task
    }))
}

/** Persist a classified failure and end the loop with the failed outcome. */
export async function failStep(
    deps: TransitionDeps,
    runId: string,
    taskId: string,
    failureClass: FailureClass,
    reason: string
): Promise<TaskStep> {
    await failTask(deps, runId, taskId, failureClass, reason)
    return {done: true, outcome: {outcome: 'failed', failure_class: failureClass, reason}}
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
    resumePhase: TaskPhase
): Promise<TaskStep> {
    if (decision.action === 'fail') {
        return failStep(deps, runId, taskId, decision.failureClass, decision.reason)
    }
    const run = await deps.state.read(runId)
    const task = run.tasks[taskId]
    if (task === undefined) {
        throw new Error(`transitions: task '${taskId}' vanished from run '${runId}'`)
    }
    if (task.escalation_rung >= ESCALATION_CAP) {
        return failStep(
            deps,
            runId,
            taskId,
            'capability-budget',
            `producer escalation cap (${ESCALATION_CAP}) reached without clearing the merge gate: ${decision.reason}`
        )
    }
    const nextRung = task.escalation_rung + 1
    await deps.state.updateTask(runId, taskId, (t) => ({
        ...t,
        escalation_rung: nextRung,
        reviewers: [],
    }))
    log.info(`task '${taskId}' escalating to rung ${nextRung}; resuming at '${resumePhase}' (${decision.reason})`)
    return {done: false, phase: resumePhase}
}

/**
 * Map a non-`done` {@link ProducerOutcome} to a classify decision (Δ D).
 * `needs-context` and `error` throw LOUD: neither is a capability failure —
 * both are handled by {@link applyProducerOutcome} BEFORE classification
 * (Decisions 69/71), so a caller routing one here is a bug, not a rung burn.
 */
export function classifyProducerFailure(outcome: ProducerOutcome): ClassifyDecision {
    if (outcome.status === 'done') {
        throw new Error("transitions: classifyProducerFailure called on a 'done' outcome")
    }
    if (outcome.status === 'needs-context' || outcome.status === 'error' || outcome.status === 'already-satisfied') {
        throw new Error(
            `transitions: classifyProducerFailure called on a '${outcome.status}' outcome — ` +
                'handled before classification (Decisions 69/70/71), never a ladder retry'
        )
    }
    return classifyFailure({
        kind: 'producer-status',
        status: outcome.status,
        reason: outcome.reason,
    })
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
    opts: {readonly role: ProducerRole; readonly phase: TaskPhase; readonly resumePhase: TaskPhase},
    outcome: ProducerOutcome
): Promise<TaskStep> {
    if (outcome.status === 'done') {
        await deps.state.updateTask(runId, taskId, (t) => ({
            ...t,
            producer_role: opts.role,
            // A completed test-writer re-run resolves any pending defect feedback — clear
            // it so a stale note never leaks into a later rung's regeneration.
            ...(opts.role === 'test-writer' ? {test_revision_feedback: undefined} : {}),
            // A completed producer (any role) resolves any open NEEDS_CONTEXT question
            // by construction (Decision 69) — clear it so a stale question never leaks.
            needs_context: undefined,
        }))
        return {done: false, phase: opts.resumePhase}
    }
    // A dead/no-STATUS spawn is an INFRA signal, not producer incapability
    // (Decision 71): re-spawn at the SAME (phase, rung). The re-emission hits the
    // orchestrator's matching spawn_in_flight branch, which spends one `redrives`
    // slot (cap SPAWN_REDRIVE_CAP) and fails `blocked-environmental` over-cap —
    // exactly the Decision 66 outcome — instead of burning an escalation rung.
    if (outcome.status === 'error') {
        log.warn(
            `task '${taskId}' producer spawn produced no usable STATUS (${outcome.reason}) — ` +
                're-spawning at the same rung (spends one spawn re-drive slot)'
        )
        return {done: false, phase: opts.phase}
    }
    // NEEDS_CONTEXT is a QUESTION, not a capability failure (Decision 69): the
    // first ask persists the question and re-spawns ONCE at the same rung with it
    // injected (handlers' needsContextNote); a second consecutive ask fails LOUD
    // with class `needs-context` so rescue can surface the question to a human.
    if (outcome.status === 'needs-context') {
        const run = await deps.state.read(runId)
        const asked = run.tasks[taskId]?.needs_context !== undefined
        await deps.state.updateTask(runId, taskId, (t) => ({
            ...t,
            // Refresh to the CURRENT question (dropping any spent answer) so rescue
            // always surfaces what the latest attempt actually asked.
            needs_context: {question: outcome.reason},
        }))
        if (asked) {
            return failStep(
                deps,
                runId,
                taskId,
                'needs-context',
                `producer needs context (asked twice without resolving): ${outcome.reason}`
            )
        }
        log.warn(`task '${taskId}' producer asked NEEDS_CONTEXT — one same-rung re-ask with the question injected`)
        return {done: false, phase: opts.phase}
    }
    // An ALREADY_SATISFIED claim must be VERIFIED against git + the test gate by
    // record.ts BEFORE this state seam (Decision 70) — reaching here unverified is
    // an engine bug, never a silent complete or a rung burn.
    if (outcome.status === 'already-satisfied') {
        throw new Error(
            `transitions: applyProducerOutcome called on an 'already-satisfied' outcome for task ` +
                `'${taskId}' — the claim must be engine-verified in record.ts first (Decision 70)`
        )
    }
    // A `test-defective` escalation (only the implementer raises it) recovers by
    // RE-RUNNING THE TEST-WRITER: persist the defect feedback and resume at `tests`
    // (not the implementer's own `exec` phase). The escalation cap still bounds it.
    if (outcome.status === 'test-defective') {
        if (opts.phase !== 'exec') {
            // The parser is role-blind, so a non-exec role can emit 'test-defective'.
            // Nonsensical for the role — an infra-grade garbage signal: re-spawn at the
            // same (phase, rung) on the re-drive budget, like a no-STATUS spawn.
            log.warn(
                `task '${taskId}' emitted 'test-defective' from non-exec role '${opts.role}' — ` +
                    're-spawning at the same rung (spends one spawn re-drive slot)'
            )
            return {done: false, phase: opts.phase}
        }
        await deps.state.updateTask(runId, taskId, (t) => ({
            ...t,
            test_revision_feedback: outcome.reason,
        }))
        return escalateOrFail(deps, runId, taskId, classifyProducerFailure(outcome), 'tests')
    }
    return escalateOrFail(deps, runId, taskId, classifyProducerFailure(outcome), opts.phase)
}
