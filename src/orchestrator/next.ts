/**
 * The RUN-LEVEL COROUTINE — the engine half of the `factory next-task` seam.
 *
 * One invocation = one run-loop iteration: terminal check → quota gate (persisting
 * pause/suspend) → checkpoint clear on recovery → cascade-fail (transitive,
 * blocked-environmental) → the READY set. Ready = every NON-TERMINAL task whose
 * deps are all `done` — in-flight tasks come first so a crashed runner finishes
 * what it started before opening new work.
 *
 * Circuit breaker (Decision 34): when no task is actionable yet non-terminal work
 * remains (dependency cycle / mutually-stuck graph), each wedged task is failed as
 * `spec-defect` and the envelope `all-terminal` is returned. The orchestrator routes this
 * to finalize → `failed`, leaving `develop` clean. Every fail is LOUD (failTask
 * warns) with the full wedged set in the reason.
 *
 * Ordering invariant: terminal-run check BEFORE the quota gate — a terminal probe
 * must not write a pause checkpoint (same discipline as nextAction in orchestrator.ts).
 *
 * Clearing a stale paused/suspended checkpoint on recovery is THIS CALLER's job
 * (the quota gate doc is explicit: "on proceed the gate never writes state;
 * clearing a stale checkpoint on recovery is the CALLER's job").
 *
 * Single-writer assumption: lock-free snapshot reads are sound because v1 has
 * exactly one orchestrator process writing state; subagents never write run state.
 *
 * `cascade_failed` on the `all-terminal` variant is THIS-INVOCATION-ONLY — it
 * lists tasks failed by the cascade loop in this call. Authoritative fail
 * visibility lives in run state (task.status === "failed") and the finalize
 * rollup.
 */
import {
    type TERMINAL_RUN_STATUSES,
    isTerminalRunStatus,
    isTerminalTaskStatus,
    clearCheckpoint,
    decideFinalize,
    type RunState,
    type TaskState,
} from './deps.js'
import {failTask} from './transitions.js'
import {MAX_DOCS_ATTEMPTS} from './docs.js'
import {MAX_TRACE_ATTEMPTS} from './traceability.js'
import {applyQuotaGate, quotaStopFields, type QuotaStop} from './quota-gate.js'
import {applyCircuitBreaker} from './circuit-breaker-gate.js'
import type {OrchestratorDeps} from './orchestrator.js'

/**
 * Every variant carries the run's self-resolved context — `run_id`, the canonical
 * `data_dir` (from {@link resolveDataDir}), and the persisted `ship_mode`. The
 * runner adopts these from the FIRST envelope instead of re-passing them per call.
 */
interface NextContext {
    readonly run_id: string
    readonly data_dir: string
    readonly ship_mode: RunState['ship_mode']
}

export type NextTask =
    | (NextContext & {
          readonly kind: 'work'
          readonly ready: readonly string[]
          readonly cascade_failed: readonly string[]
          /** Max tasks the runner may drive in flight at once (config `maxParallelTasks`). */
          readonly max_parallel: number
      })
    | (NextContext & {
          readonly kind: 'finalize'
          /** Tasks failed by the cascade loop in THIS invocation (not cumulative). */
          readonly cascade_failed: readonly string[]
      })
    | (NextContext & {
          readonly kind: 'document'
      })
    | (NextContext & {
          /** The PRD-traceability phase (S9, Decision 47) — ordered AFTER e2e, BEFORE `document`. */
          readonly kind: 'traceability'
      })
    | (NextContext & {
          /** The e2e phase (Decision 39) — ordered BEFORE `document`. */
          readonly kind: 'e2e'
      })
    | (NextContext & {
          /** The run-start e2e assessment (Decision 40 D3) — ordered BEFORE any task. */
          readonly kind: 'e2e-assessment'
      })
    | (NextContext & {
          readonly kind: 'done'
          readonly run_status: (typeof TERMINAL_RUN_STATUSES)[number]
      })
    | (NextContext & {
          readonly kind: 'pause'
          readonly scope: QuotaStop['scope']
          readonly reason: string
          readonly resets_at_epoch?: number
      })

/** True iff every dependency of `task` is `done`. */
function depsSatisfied(run: RunState, task: TaskState): boolean {
    return task.depends_on.every((d) => run.tasks[d]?.status === 'done')
}

/** A dependency is unsatisfiable when it is absent or already failed. */
function isUnsatisfiableDep(run: RunState, depId: string): boolean {
    const dep = run.tasks[depId]
    return dep === undefined || dep.status === 'failed'
}

/**
 * True iff a fully-terminal run still needs its docs phase: prospective status
 * `completed`, docs not already `done`, and docs applicable to the target repo.
 * The caller MUST guarantee all tasks are terminal — decideFinalize throws otherwise.
 *
 * A `failed` e2e phase (Decision 39) skips docs entirely — the run is headed
 * straight to finalize (which overrides the terminal status to `failed`; see
 * finalize.ts), so documenting code the e2e verdict just condemned is pointless.
 */
async function wantsDocs(deps: OrchestratorDeps, run: RunState): Promise<boolean> {
    if (run.docs?.status === 'done') {
        return false
    }
    if ((run.docs?.attempts ?? 0) >= MAX_DOCS_ATTEMPTS) {
        return false
    } // cap: treat docs as done
    if (run.e2e_phase?.status === 'failed') {
        return false
    }
    // A failed assessment (Decision 40) also condemns the run — same rationale.
    if (run.e2e_assessment?.status === 'failed') {
        return false
    }
    // A failed traceability audit (S9) condemns the run too — never pay the docs
    // Opus on a run finalize is about to override to `failed`.
    if (run.traceability?.status === 'failed') {
        return false
    }
    if (decideFinalize(run).run_status !== 'completed') {
        return false
    }
    return deps.docsApplicable()
}

/**
 * True iff a fully-terminal run still owes its PRD-traceability audit (S9,
 * Decision 47): prospectively `completed`, not a debug run (`/factory:debug`'s
 * review⇄fix loop IS its traceability), not already condemned by e2e/assessment,
 * and the phase has not CONCLUDED. Ordered AFTER e2e (audit the diff the e2e
 * loop settled) and BEFORE docs (a condemned run never pays the docs Opus, and
 * docs commits never pollute the audited diff).
 *
 * Concluded-vs-crash on a `failed` marker is DERIVED, never stored (the
 * verdicts-presence discriminant): verdicts non-empty = a parsed audit landed an
 * `unmet` verdict (judgment — never re-fired); verdicts empty + attempts at the
 * cap = concluded crash; otherwise a crash still awaiting its retry → re-fire.
 */
function wantsTraceability(run: RunState): boolean {
    if (run.debug) {
        return false
    }
    if (run.traceability?.status === 'done') {
        return false
    }
    if (run.traceability?.status === 'failed') {
        if (run.traceability.verdicts.length > 0) {
            return false
        } // concluded: unmet verdict
        if ((run.traceability.attempts ?? 0) >= MAX_TRACE_ATTEMPTS) {
            return false
        } // concluded: crash cap
        // else: crash below the cap — re-fire the audit.
    }
    if (run.e2e_phase?.status === 'failed') {
        return false
    }
    if (run.e2e_assessment?.status === 'failed') {
        return false
    }
    return decideFinalize(run).run_status === 'completed'
}

/**
 * True iff a fully-terminal run still needs its e2e phase (Decision 39): the run
 * opted in (`--e2e` → `run.e2e`), the phase has not already CONCLUDED this run
 * (`done` or `failed` — a `failed` verdict carries straight through to finalize,
 * it is never re-entered), and the run is PROSPECTIVELY `completed` (every task
 * shipped). Ordered BEFORE `wantsDocs` — don't document code the e2e phase may
 * still reopen a task to change.
 *
 * `e2e_phase.status` is CLEARED (reset to absent) by the e2e coroutine on every
 * reopen, so this gate re-fires once the reopened task settles back to terminal —
 * unlike docs, which never re-enters once `done`.
 */
function wantsE2e(run: RunState): boolean {
    if (!run.e2e) {
        return false
    }
    if (run.e2e_phase?.status !== undefined) {
        return false
    } // "done" or "failed" — concluded
    // A failed assessment condemns the run to finalize→failed (Decision 40) — spawning
    // the author against a repo the assessor just proved un-bootable is pointless.
    if (run.e2e_assessment?.status === 'failed') {
        return false
    }
    return decideFinalize(run).run_status === 'completed'
}

/**
 * True iff the run still owes its run-start e2e ASSESSMENT (Decision 40 D3): opted
 * into `--e2e` and the assessment hasn't CONCLUDED (`status` absent covers both
 * never-spawned and a crashed attempt awaiting its retry; `failed` never re-fires —
 * the record leg already swept the tasks and the run is headed to finalize).
 *
 * Fires while tasks are still pending (assessment runs BEFORE any task) AND on an
 * all-terminal run that still wants its e2e phase (a pre-assessment in-flight run
 * resumed mid-flight, R11) — but NOT on a run already condemned to finalize.
 */
function wantsE2eAssessment(run: RunState, allTerminal: boolean, needsE2e: boolean): boolean {
    if (!run.e2e) {
        return false
    }
    if (run.e2e_assessment?.status !== undefined) {
        return false
    }
    return !allTerminal || needsE2e
}

export async function nextTask(deps: OrchestratorDeps, runId: string): Promise<NextTask> {
    let run = await deps.state.read(runId)

    // Self-resolved run context stamped onto EVERY envelope variant (so the runner
    // adopts run_id/data_dir/ship_mode from the first `next`).
    // `data_dir`/`ship_mode` are immutable for the run; reading the current `run`
    // snapshot at call time is always correct even after the cascade re-reads `run`.
    const ctx = () => ({run_id: runId, data_dir: deps.dataDir, ship_mode: run.ship_mode})

    // 1. Terminal run check BEFORE the quota gate — a finished run must never
    //    write a pause checkpoint (mirrors nextAction in orchestrator.ts).
    if (isTerminalRunStatus(run.status)) {
        return {...ctx(), kind: 'done', run_status: run.status}
    }

    // 2. All-tasks-terminal check BEFORE the quota gate. A GENUINELY finished run
    //    early-returns here (a finished run must never write a pause checkpoint). But a
    //    run whose tasks are all terminal yet whose e2e/docs phase is still pending is NOT
    //    finished: it falls through to the quota gate + checkpoint clear so a
    //    e2e/docs-suspended run resumes cleanly, then returns the phase kind after step 4.
    //    e2e is evaluated BEFORE docs (Decision 39) and short-circuits it: `needsDocs`
    //    is never even computed while e2e still has work to do.
    const allTerminal = Object.values(run.tasks).every((t) => isTerminalTaskStatus(t.status))
    const needsE2e = allTerminal && wantsE2e(run)
    const needsAssessment = wantsE2eAssessment(run, allTerminal, needsE2e)
    const needsTrace = allTerminal && !needsE2e && wantsTraceability(run)
    const needsDocs = allTerminal && !needsE2e && !needsTrace && (await wantsDocs(deps, run))
    if (allTerminal && !needsE2e && !needsTrace && !needsDocs) {
        // Clear quota checkpoint before finalizing: a paused run whose tasks all complete
        // bypasses the step-4 clear below. Without this, a stop between this return and
        // factory-run-finalize strands the run as paused (stop-gate returns ALLOW for
        // non-running, so it never self-finalizes). Mirrors the step-4 recovery clear below.
        if (run.status === 'paused' || run.status === 'suspended') {
            const patch = clearCheckpoint()
            await deps.state.update(runId, (s) => ({...s, status: patch.status, quota: patch.quota}))
        }
        return {...ctx(), kind: 'finalize', cascade_failed: []}
    }

    // 3. Quota gate — a breach persists the checkpoint and stops cleanly.
    //    --ignore-quota skips pacing (Decision 24).
    const stop = await applyQuotaGate(deps, runId, run.ignore_quota)
    if (stop !== null) {
        return {...ctx(), kind: 'pause', ...quotaStopFields(stop)}
    }

    // 4. Clear stale checkpoint on recovery (paused/suspended → running). The gate
    //    returns null (proceed) for a paused run whose window has expired, but the
    //    run.status is still "paused" — we must reset it and drop the quota field.
    if (run.status === 'paused' || run.status === 'suspended') {
        const patch = clearCheckpoint()
        run = await deps.state.update(runId, (s) => ({
            ...s,
            status: patch.status,
            quota: patch.quota,
        }))
    }

    // E2E ASSESSMENT gate (Decision 40 D3): checked BEFORE everything else the run
    // can do — before the ready-task set (assessment runs before ANY task) and before
    // the e2e phase (the author needs the assessment's machinery + resolved config).
    if (needsAssessment) {
        return {...ctx(), kind: 'e2e-assessment'}
    }

    // E2E gate (Decision 39): a completed run that opted into `--e2e` and hasn't
    // concluded its e2e phase yet. Checked BEFORE docs — a reopen loops back through
    // the ready-task set below, and docs must not run against code the e2e verdict
    // may still send back for rework.
    if (needsE2e) {
        return {...ctx(), kind: 'e2e'}
    }

    // Traceability gate (S9, Decision 47): a prospectively-completed run that has
    // not concluded its PRD audit. AFTER e2e (audit the settled diff), BEFORE docs
    // (a condemned run never pays the docs Opus; docs commits stay out of the
    // audited diff). Reached AFTER the checkpoint clear, like docs below.
    if (needsTrace) {
        return {...ctx(), kind: 'traceability'}
    }

    // Docs gate: a completed run with a pending, applicable docs phase. Reached only
    // when `needsDocs` (all tasks terminal), and AFTER the checkpoint clear so a
    // docs-suspended run is back to `running` first. `needsDocs` was computed from the
    // entry snapshot; the checkpoint clear changes only status/quota, never tasks/docs.
    if (needsDocs) {
        return {...ctx(), kind: 'document'}
    }

    // 5. Cascade-fail until stable. Pending tasks with an unsatisfiable dep are
    //    failed as blocked-environmental; a fail can expose further blocked tasks.
    const cascadeFailed: string[] = []
    for (;;) {
        run = await deps.state.read(runId)
        const blocked = Object.values(run.tasks).filter(
            (t) => t.status === 'pending' && t.depends_on.some((d) => isUnsatisfiableDep(run, d))
        )
        if (blocked.length === 0) {
            break
        }
        for (const t of blocked) {
            const unsatisfied = t.depends_on.find((d) => isUnsatisfiableDep(run, d))
            if (unsatisfied === undefined) {
                throw new Error(
                    `next: task '${t.task_id}' classified blocked but no unsatisfiable dep found — unreachable`
                )
            }
            await failTask(
                deps,
                runId,
                t.task_id,
                'blocked-environmental',
                `dependency '${unsatisfied}' did not complete (failed or missing)`
            )
            cascadeFailed.push(t.task_id)
        }
    }
    // `run` is fresh from the loop's last read (no writes since the loop exited).

    // 6. All-tasks-terminal after cascade — the cascade may have resolved the run.
    const tasks = Object.values(run.tasks)

    if (tasks.every((t) => isTerminalTaskStatus(t.status))) {
        return {...ctx(), kind: 'finalize', cascade_failed: cascadeFailed}
    }

    // 6b. Run-level circuit breaker (WS4) — distinct from both the recoverable quota
    //     pause and the Decision-34 wedge-fail below. Trips on genuine repeated
    //     capability failures. Placed AFTER the terminal checks (never abort an
    //     already-finished run; never write on a terminal run) and AFTER the quota
    //     gate (a paused run early-returns above, so quota waiting never trips the
    //     breaker). A trip is a HARD abort — fail every remaining non-terminal task
    //     LOUD (capability-budget, breaker reason carried) and fall through to
    //     all-terminal → finalize → `failed`, reusing the wedge-fail path.
    const breaker = await applyCircuitBreaker(deps, runId)
    if (breaker !== null) {
        for (const t of tasks.filter((x) => !isTerminalTaskStatus(x.status))) {
            await failTask(deps, runId, t.task_id, 'capability-budget', `circuit breaker tripped: ${breaker.reason}`)
            cascadeFailed.push(t.task_id)
        }
        run = await deps.state.read(runId)
        return {...ctx(), kind: 'finalize', cascade_failed: cascadeFailed}
    }

    // 7. Build the ready set: non-terminal tasks whose deps are all done.
    //    In-flight tasks (status !== "pending") come first — crash-resume finishes
    //    what was started before opening new work.
    const ready = tasks.filter((t) => !isTerminalTaskStatus(t.status) && depsSatisfied(run, t))
    const inFlight = ready.filter((t) => t.status !== 'pending').map((t) => t.task_id)
    const pending = ready.filter((t) => t.status === 'pending').map((t) => t.task_id)
    const ordered = [...inFlight, ...pending]

    if (ordered.length === 0) {
        // Circuit breaker (Decision 34): no task is actionable yet non-terminal work
        // remains — a dependency cycle / mutually-stuck graph that no future iteration
        // can resolve. Rather than throw (anti-spin), DROP each wedged task as a
        // spec-defect and fall through to all-terminal → finalize → `failed` (develop
        // stays clean). LOUD: every fail is recorded with its reason (failTask warns).
        const wedged = tasks.filter((t) => !isTerminalTaskStatus(t.status))
        const detail = wedged.map((t) => `${t.task_id}=${t.status}`).join(', ')
        for (const t of wedged) {
            await failTask(
                deps,
                runId,
                t.task_id,
                'spec-defect',
                `unrunnable: no ready task and no satisfiable path (dependency cycle/deadlock) — wedged set [${detail}]`
            )
            cascadeFailed.push(t.task_id)
        }
        run = await deps.state.read(runId)
        return {...ctx(), kind: 'finalize', cascade_failed: cascadeFailed}
    }

    return {
        ...ctx(),
        kind: 'work',
        ready: ordered,
        cascade_failed: cascadeFailed,
        max_parallel: deps.config.maxParallelTasks,
    }
}
