/**
 * WS12 — rescue SCAN (the read-only diagnostic; Decision 22, Δ S).
 *
 * A run can stop in a shape `factory resume` cannot untangle: a crashed or
 * suspended session left tasks STUCK mid-phase (status `executing`/`reviewing`/
 * `shipping`) with no determination ever reached. The orchestrator has no handler for a
 * stuck in-flight task — the run-level orchestrator (`nextTask`) THROWS "dependency cycle or deadlock" the moment
 * no task is actionable (no ready/cascade-failable `pending` task) yet non-terminal
 * work remains. Resume never touches task state (it only clears the quota gate), so
 * resume alone cannot recover such a run.
 *
 * Rescue fills exactly that gap. `scanRun` is the PURE, read-only survey: it
 * classifies every task by what rescue can do with it and reports whether a re-drive
 * would deadlock — the input the runner (and, for ambiguous failures, the
 * rescue-diagnostic agent) reasons over before calling `rescue apply`.
 *
 * "Without repeating dead ends" (the WS12 acceptance) is encoded in the disposition:
 *   - `failed` + `blocked-environmental` → RECOVERABLE: the blocker (a flaky env, a
 *     dependency that has since been reset) may have cleared, so a default rescue
 *     re-attempts it (Decision: "prefer recovery over abandonment");
 *   - `failed` + `spec-defect` / `capability-budget` → DEAD-END: re-running repeats a
 *     determined failure, so a default rescue LEAVES it failed. It is reset only when
 *     a human explicitly asserts the root cause is fixed (`apply --include-dead-ends`).
 *
 * SCOPE (v1): rescue reconciles RUN STATE only. GitHub-side drift (a PR merged but not
 * recorded, an orphan worktree, a closed-unmerged PR) is NOT reconciled here — the old
 * bash issue-taxonomy is reference, not a port. This module is pure over {@link RunState}
 * so it stays trivially testable; gh reconciliation is a deferred enhancement, not a
 * silent omission.
 */
import {isTerminalTaskStatus, isTerminalRunStatus} from '../types/index.js'
import {depsSatisfied, isUnsatisfiableDep} from '../orchestrator/readiness.js'
import type {RunState, RunStatus, TaskStatus, FailureClass} from '../types/index.js'

/** What rescue can do with a task. */
export type RescueDisposition =
    /** `done` — merged into staging; NEVER touched (resetting would un-ship). */
    | 'shipped'
    /** `pending` — already runnable; the orchestrator will pick it up. */
    | 'runnable'
    /** in-flight (`executing`/`reviewing`/`shipping`) — crashed mid-phase; resettable. */
    | 'stuck'
    /** `failed` + `blocked-environmental` — the blocker may have cleared; resettable. */
    | 'recoverable'
    /** `failed` + `spec-defect`/`capability-budget` — re-running repeats it; left alone. */
    | 'dead-end'

/** One task's rescue classification. */
export interface RescueTaskLine {
    task_id: string
    status: TaskStatus
    disposition: RescueDisposition
    failure_class?: FailureClass
    failure_reason?: string
    branch?: string
    pr_number?: number
}

/** The read-only rescue diagnostic for a run. Deterministic given the run state. */
export interface RescueScan {
    run_id: string
    run_status: RunStatus
    counts: {
        total: number
        shipped: number
        runnable: number
        stuck: number
        recoverable: number
        dead_end: number
    }
    /** Tasks a DEFAULT `rescue apply` resets to pending (stuck ∪ recoverable). */
    resettable: string[]
    /** Failed dead-ends reset only with `--include-dead-ends` (+ a real fix). */
    dead_ends: string[]
    /** True iff there is anything for rescue to reset (task-level OR a failed e2e verdict). */
    needs_rescue: boolean
    /**
     * True iff `run.e2e_phase.status === "failed"` — a run can be stuck on this ALONE
     * (every task `done`, `resettable` empty), which a task-only `needs_rescue` would
     * otherwise miss. Never auto-reset (Decision 39 W4): `apply --reset-e2e` requires
     * the human to assert the underlying cause no longer applies.
     */
    e2e_failed: boolean
    /**
     * True iff `run.e2e_assessment.status === "failed"` (Decision 40) — the run-start
     * assessment condemned the run (tasks swept blocked-environmental, so they show as
     * `recoverable` here). `apply --reset-e2e` also drops the failed assessment so a
     * resumed re-drive re-fires it fresh.
     */
    e2e_assessment_failed: boolean
    /**
     * True iff `run.traceability.status === "failed"` (S9, Decision 47) — the PRD-
     * traceability audit condemned the run (an unmet requirement, or an auditor crash
     * at cap). `apply --reset-traceability` drops the whole marker so a resumed re-drive
     * re-fires the audit fresh. Alone flips `needs_rescue` true (route `page`).
     */
    traceability_failed: boolean
    /**
     * True iff `run.rollup` is present with `merged:false` — either a `completed` run
     * whose staging→develop rollup was ARMED but never landed (e.g. the "auto-armed"
     * branch-policy fallback, finding #5), or a NON-terminal run that hit a
     * forward-reconcile conflict in finalize. Never auto-recovered: the former via
     * `apply --recheck-rollup` (reopens the run so a re-drive re-enters finalize,
     * whose rollup() resume-guard picks up the now-merged PR), the latter via a human
     * resolving the conflict + plain `factory resume`.
     */
    rollup_pending: boolean
    /**
     * True iff a re-drive would THROW: non-terminal work remains but no task is
     * actionable (none ready, none cascade-failable) — the orchestrator's deadlock guard.
     * A terminal `failed`/`completed`/`superseded` run is never "deadlocked" (it already finalized);
     * it may still be `needs_rescue` (recoverable failures to retry on reopen).
     */
    would_deadlock: boolean
    /** One-line human summary. */
    summary: string
    /** Per-task lines, in run.tasks order. */
    tasks: RescueTaskLine[]
}

/** Classify one task. */
function dispositionOf(status: TaskStatus, failureClass: FailureClass | undefined): RescueDisposition {
    if (status === 'done') {
        return 'shipped'
    }
    if (status === 'pending') {
        return 'runnable'
    }
    if (status === 'failed') {
        return failureClass === 'blocked-environmental' ? 'recoverable' : 'dead-end'
    }
    // executing | reviewing | shipping
    return 'stuck'
}

/**
 * Survey a run and classify every task for rescue. Pure + read-only — no state
 * writes, no gh, no agent spawns (the diagnostic LLM is the runner's job;
 * this is its input). See the module header for the disposition contract.
 */
export function scanRun(run: RunState): RescueScan {
    const all = Object.values(run.tasks)
    const tasks: RescueTaskLine[] = all.map((t) => ({
        task_id: t.task_id,
        status: t.status,
        disposition: dispositionOf(t.status, t.failure_class),
        ...(t.failure_class !== undefined ? {failure_class: t.failure_class} : {}),
        ...(t.failure_reason !== undefined ? {failure_reason: t.failure_reason} : {}),
        ...(t.branch !== undefined ? {branch: t.branch} : {}),
        ...(t.pr_number !== undefined ? {pr_number: t.pr_number} : {}),
    }))

    const by = (d: RescueDisposition): RescueTaskLine[] => tasks.filter((t) => t.disposition === d)
    const stuck = by('stuck')
    const recoverable = by('recoverable')
    const deadEnd = by('dead-end')

    const resettable = [...stuck, ...recoverable].map((t) => t.task_id)
    const dead_ends = deadEnd.map((t) => t.task_id)

    const allTerminal = all.every((t) => isTerminalTaskStatus(t.status))
    // A pending task is "actionable" to the orchestrator: it either runs (deps done) or is
    // cascade-failed (a dep failed/missing). If no task is actionable yet non-terminal
    // work remains, a re-drive throws — that is `would_deadlock`.
    const actionablePending = all.some(
        (t) =>
            t.status === 'pending' &&
            (depsSatisfied(run, t.depends_on) || t.depends_on.some((d) => isUnsatisfiableDep(run, d)))
    )
    const would_deadlock = !allTerminal && !actionablePending
    const e2e_failed = run.e2e_phase?.status === 'failed'
    const e2e_assessment_failed = run.e2e_assessment?.status === 'failed'
    const traceability_failed = run.traceability?.status === 'failed'
    const rollup_pending = run.rollup?.merged === false
    const needs_rescue =
        resettable.length > 0 || e2e_failed || e2e_assessment_failed || traceability_failed || rollup_pending

    return {
        run_id: run.run_id,
        run_status: run.status,
        counts: {
            total: all.length,
            shipped: by('shipped').length,
            runnable: by('runnable').length,
            stuck: stuck.length,
            recoverable: recoverable.length,
            dead_end: deadEnd.length,
        },
        resettable,
        dead_ends,
        needs_rescue,
        e2e_failed,
        e2e_assessment_failed,
        traceability_failed,
        rollup_pending,
        would_deadlock,
        summary: summarize(
            run.status,
            resettable.length,
            dead_ends.length,
            would_deadlock,
            e2e_failed,
            e2e_assessment_failed,
            traceability_failed,
            rollup_pending
        ),
        tasks,
    }
}

/** Build the one-line summary. */
function summarize(
    status: RunStatus,
    resettable: number,
    deadEnds: number,
    wouldDeadlock: boolean,
    e2eFailed: boolean,
    e2eAssessmentFailed: boolean,
    traceabilityFailed: boolean,
    rollupPending: boolean
): string {
    const e2eTail = e2eFailed ? ' (e2e phase failed — needs a fix + --reset-e2e)' : ''
    const assessTail = e2eAssessmentFailed ? ' (e2e assessment failed — needs a fix + --reset-e2e)' : ''
    const traceTail = traceabilityFailed ? ' (PRD-traceability failed — needs a fix + --reset-traceability)' : ''
    const rollupTail = rollupPending
        ? status === 'completed'
            ? ' (rollup armed, not landed — re-run finalize once merged via --recheck-rollup)'
            : ' (forward-reconcile conflict — resolve it on the staging branch, then `factory resume`)'
        : ''
    if (resettable === 0) {
        const deadEndTail = deadEnds > 0 ? ` (${deadEnds} dead-end failure(s) — need a fix + --include-dead-ends)` : ''
        if (e2eFailed || e2eAssessmentFailed || traceabilityFailed || rollupPending) {
            return `run '${status}': no task rescue needed${deadEndTail}${e2eTail}${assessTail}${traceTail}${rollupTail}`
        }
        return `run '${status}': no rescue needed${deadEndTail}`
    }
    const reopen = isTerminalRunStatus(status) ? ' (will reopen the run)' : ''
    const deadlock = wouldDeadlock ? '; a re-drive would deadlock without rescue' : ''
    return `run '${status}': rescue can reset ${resettable} task(s)${reopen}${deadlock}${e2eTail}${assessTail}${traceTail}${rollupTail}`
}
