/**
 * WS10 — the PHASE HANDLERS (Model A REPORTERS).
 *
 * {@link makePhaseHandlers} builds the {@link PhaseHandlers} the WS2 engine
 * dispatches. Per the Model-A split (types.ts), a handler is a pure-ish REPORTER:
 * it reads the frozen {@link PhaseContext}, does DETERMINISTIC work (shell out via
 * the injected git/gate clients, persist a holdout answer-key or a producer
 * prompt-context artifact), and RETURNS a {@link PhaseResult}. A handler NEVER
 * writes run state (the orchestrator owns the StateManager), NEVER spawns an agent (it
 * reports a `spawn-agents` request the orchestrator acts on), and NEVER decides a
 * transition beyond naming the phase it advances/resumes at.
 *
 * The producer escalation ladder is re-expressed PER INVOCATION off the persisted
 * `escalation_rung`: every producer-spawning phase reads `task.escalation_rung`,
 * dials the model + prior-failure injection for that rung ({@link dialForRung}),
 * and the ORCHESTRATOR bumps the rung on a classified retry. There is no `runLadder`
 * call here — v1 re-expresses only the OUTER ladder via the persisted rung.
 *
 * VERIFY + SHIP. The `verify` reporter here derives the merge gate from the
 * already-recorded reviewers + gate evidence; it does NOT itself spawn the panel or
 * the holdout-validator (a handler cannot spawn). The orchestrator emits those agents out of
 * band — the panel as the verify spawn request, the holdout-validator as a holdout —
 * and records their results via the record cores. `ship` is NOT served from this reporter
 * at all: the orchestrator runs the stateful {@link import("./ship.js").shipTask} (PR pointer
 * writes + the live MergeSerializer) directly, since a reporter cannot write state or
 * merge.
 */
import {
    advance,
    spawn,
    waitRetry,
    deriveMergeGateVerdict,
    mergeGateBlockReason,
    createTaskWorktree,
    provisionWorktree,
    GateRunner,
    FsCoverageStore,
    buildPanelManifest,
    panelRolesFor,
    touchesDatabase,
    resolveReviewModel,
    dialForRung,
    buildProducerContext,
    resolveCodexCrossVendor,
    ESCALATION_CAP,
    splitHoldout,
    makeHoldoutRecord,
    parseSpawnRequest,
    decideFinalize,
    type Config,
    type GateContext,
    type PriorFailureNote,
    type ConfirmedBlocker,
    type ProducerContext,
    type SpawnRequest,
    type SpecManifest,
    type SpecTask,
    type PhaseContext,
    type PhaseHandlers,
    type PhaseResult,
    type TaskPhase,
    type TaskState,
} from './deps.js'
import type {HandlerDeps} from './types.js'
import {taskWorktreePath} from './paths.js'
import {taskExemptReader} from './exempt.js'
import {runCoverageDir} from '../core/state/index.js'
import {FsHoldoutVerdictStore, deriveHoldoutEvidence} from '../verifier/holdout/index.js'
import {withFileLock, DEFAULT_FILE_LOCK_TUNING, type FileLockTuning} from '../shared/index.js'
import {join} from 'node:path'

/**
 * Preflight git-lock tuning — same values as the MergeSerializer's
 * MERGE_LOCK_DEFAULTS: worktree creation shells real git (fetch + worktree add),
 * so hold times are seconds, not millis; retries stretch accordingly.
 */
const PREFLIGHT_GIT_LOCK_TUNING: FileLockTuning = {
    ...DEFAULT_FILE_LOCK_TUNING,
    stale: 30_000,
    retries: 100,
    retryMinTimeout: 25,
    retryMaxTimeout: 1000,
}

/**
 * A producer role the tests/exec reporters spawn. Mirrors the WS8
 * {@link import("./deps.js").ProducerRole} vocabulary; declared locally so the
 * request builder stays self-contained.
 */
type ProducerSpawnRole = 'test-writer' | 'implementer'

/**
 * Build the {@link PhaseHandlers} bound to one reporter dependency bundle. Stateless
 * apart from the closure over `deps`; every method is idempotent given identical
 * frozen state + identical tool outputs.
 */
export function makePhaseHandlers(deps: HandlerDeps): PhaseHandlers {
    // -- shared reporter helpers ---------------------------------------------

    /** The task the engine is acting on; absent only for the run-level finalize. */
    function requireTask(ctx: PhaseContext, phase: string): TaskState {
        if (ctx.task === undefined) {
            throw new Error(`handlers: phase '${phase}' requires a task but ctx.task is absent`)
        }
        return ctx.task
    }

    /**
     * The deterministic holdout split for a task. Seeded with `${runId}:${taskId}` so
     * the tests phase (which PERSISTS the answer key) and the exec phase (which only
     * RECOMPUTES the visible remainder) independently derive the SAME partition.
     */
    function splitFor(config: Config, runId: string, specTask: SpecTask) {
        return splitHoldout(specTask.acceptance_criteria, config.quality.holdoutPercent, `${runId}:${specTask.task_id}`)
    }

    /**
     * The prior-failure "don't do this" note injected on rung ≥ 2 (the rung-2 changed
     * variable, Decision 25). The reporter has only the persisted rung — not the
     * earlier verifier detail (that richer fix-forward signal is the loop's job, not
     * the v1 outer-ladder re-expression) — so it synthesizes a rung-keyed note. Its
     * PRESENCE is what makes {@link buildProducerContext} set `injectedPriorFailure`.
     */
    function priorFailureNote(rung: number): PriorFailureNote {
        const prior = Math.max(0, rung - 1)
        return {
            rung: prior,
            summary: `prior attempt at rung ${prior} did not clear the merge gate`,
        }
    }

    /**
     * On an e2e reopen (Decision 39), the run-level e2e coroutine carries a failing
     * journey's feedback onto the task row and resets it to `pending`. Injected into
     * BOTH producer roles — unlike `test_revision_feedback` (test-writer only), an e2e
     * failure could equally mean the implementation OR the test itself is wrong, so
     * both need the same signal. Cleared on the next `completeTask` (transitions.ts).
     */
    function e2eFeedbackNote(task: TaskState): PriorFailureNote[] {
        return task.e2e_feedback !== undefined
            ? [
                  {
                      rung: task.escalation_rung,
                      summary:
                          `An end-to-end journey test FAILED against this task's previously-shipped ` +
                          `work: ${task.e2e_feedback}. Fix the underlying issue — implementation or test, ` +
                          `whichever is wrong — so the journey passes.`,
                  },
              ]
            : []
    }

    /**
     * Assemble + PERSIST a producer prompt-context for `(role, rung)` and return the
     * one-agent spawn request that resumes at `resumePhase`. The context is built from
     * the holdout-stripped `visibleCriteria` only; the prior-failure note is recorded in
     * IFF the dial injects it (rung ≥ 2).
     */
    async function producerSpawn(
        role: ProducerSpawnRole,
        specTask: SpecTask,
        runId: string,
        rung: number,
        resumePhase: TaskPhase,
        extraPriorFailures: readonly PriorFailureNote[] = [],
        confirmedBlockers?: readonly ConfirmedBlocker[]
    ): Promise<PhaseResult> {
        const dial = dialForRung(specTask.risk_tier, rung, deps.config)
        const split = splitFor(deps.config, runId, specTask)
        const context: ProducerContext = buildProducerContext({
            taskId: specTask.task_id,
            title: specTask.title,
            description: specTask.description,
            visibleCriteria: split.visible,
            files: specTask.files,
            rung,
            // `extraPriorFailures` (e.g. a test-revision note) is injected regardless of
            // the rung dial — a defective RED test must be steered away from on the very
            // first regeneration (rung 1), where the generic dial note is still off.
            priorFailures: [...extraPriorFailures, ...(dial.injectsPriorFailure ? [priorFailureNote(rung)] : [])],
            // D5 fix-forward: a blocked verify's confirmed reviewer blockers ∪ gate-stderr
            // record (record.ts persisted it as `task.fix_findings`), recorded in as
            // concrete PATCH instructions rather than re-nuking the implementation.
            ...(confirmedBlockers !== undefined ? {confirmedBlockers} : {}),
        })
        const promptRef = await deps.artifacts.putProducerContext(runId, specTask.task_id, `${role}-r${rung}`, context)
        const request: SpawnRequest = parseSpawnRequest({
            resume_phase: resumePhase,
            agents: [
                {
                    role,
                    model: dial.model,
                    // No implementer-specific turn budget exists; both producer roles share the
                    // test-writer cap (documented WS10 decision).
                    max_turns: deps.config.testWriter.maxTurns,
                    prompt_ref: promptRef,
                    // Effort is set ONLY once the dial has climbed the model to its ceiling
                    // (rung ≥ 3 for sub-ceiling tasks, ≥ 2 for high-tier). Omitted ⇒ the agent
                    // inherits the spawn default — never pass `effort: undefined`.
                    ...(dial.effort !== undefined ? {effort: dial.effort} : {}),
                },
            ],
        })
        return spawn(request)
    }

    // -- phase reporters -----------------------------------------------------

    return {
        /**
         * preflight: create the per-task worktree forked off the staging tip (D12
         * base-is-staging-tip assertion lives inside createTaskWorktree), then advance
         * to the tests phase. The run-scoped branch is deterministic from (run, task),
         * so it is not threaded through state here — ship recomputes it.
         */
        async preflight(ctx: PhaseContext): Promise<PhaseResult> {
            const task = requireTask(ctx, 'preflight')
            const worktree = taskWorktreePath(deps.dataDir, ctx.run.run_id, task.task_id)
            const staging = ctx.run.staging_branch
            // Parallel preflights share the main repo's .git: `fetch` + `worktree add`
            // contend on index.lock, and the shared origin/<staging> tracking ref can move
            // between one task's fetch and another's assertBaseIsStagingTip — spuriously
            // tripping D12 invariant #4. Serialize the whole fetch→add→assert section per
            // staging branch. provisionWorktree (slow dep install) stays OUTSIDE the lock.
            const lockScope = staging.replace(/[^\w.-]/g, '-')
            await withFileLock(
                {
                    dir: join(deps.dataDir, 'locks'),
                    lockfile: join(deps.dataDir, 'locks', `preflight-git-${lockScope}.lock`),
                    label: `preflight git '${staging}'`,
                    dirPolicy: 'create',
                    tuning: PREFLIGHT_GIT_LOCK_TUNING,
                },
                () =>
                    createTaskWorktree({
                        gitClient: deps.git,
                        runId: ctx.run.run_id,
                        taskId: task.task_id,
                        path: worktree,
                        base: staging,
                    })
            )
            // Make the worktree runnable BEFORE the command-gates: install deps via the
            // configured setupCommand (else a lockfile-detected install). FAILS LOUD on a
            // bad env so it halts here, not as an opaque test/type/build gate failure.
            await (deps.provision ?? provisionWorktree)({
                path: worktree,
                setupCommand: deps.config.quality.setupCommand,
            })
            return advance('tests')
        },

        /**
         * tests: PERSIST the holdout answer-key (the only phase that does — exec merely
         * recomputes the split), then either skip the test-writer (tdd_exempt → advance
         * to exec) or spawn the test-writer for the current rung (resume at exec).
         */
        async tests(ctx: PhaseContext): Promise<PhaseResult> {
            const task = requireTask(ctx, 'tests')
            const specTask = specTaskOf(deps.spec, task.task_id)

            // Persist the answer key once, regardless of TDD exemption — holdout
            // validation is independent of whether the producer wrote tests. A degenerate
            // split (withheld 0) persists nothing, so verify's `holdout.has` short-circuits.
            const split = splitFor(deps.config, ctx.run.run_id, specTask)
            if (split.withheld.length > 0) {
                await deps.holdout.put(
                    ctx.run.run_id,
                    makeHoldoutRecord(task.task_id, split.withheld, specTask.acceptance_criteria.length)
                )
            }

            if (specTask.tdd_exempt === true) {
                return advance('exec')
            }
            // On a test-revision recovery, the implementer's defect feedback is carried on
            // the task row — inject it so the regenerated test-writer does not re-pin the
            // same wrong literal (it writes a BEHAVIORAL test instead).
            const revisionNote: PriorFailureNote[] =
                task.test_revision_feedback !== undefined
                    ? [
                          {
                              rung: task.escalation_rung,
                              summary:
                                  `Your PRIOR test for this task was rejected as INCORRECT by the implementer ` +
                                  `and reviewers: ${task.test_revision_feedback}. Write a BEHAVIORAL test derived ` +
                                  `from the acceptance criteria — do NOT pin an implementation source literal ` +
                                  `(no toContain("<source string>")).`,
                          },
                      ]
                    : []
            return producerSpawn('test-writer', specTask, ctx.run.run_id, task.escalation_rung, 'exec', [
                ...revisionNote,
                ...e2eFeedbackNote(task),
            ])
        },

        /**
         * exec: spawn the implementer for the current rung against the holdout-stripped
         * visible criteria (recomputed from the same seed — never re-persisted), resume
         * at verify.
         */
        async exec(ctx: PhaseContext): Promise<PhaseResult> {
            const task = requireTask(ctx, 'exec')
            const specTask = specTaskOf(deps.spec, task.task_id)
            return producerSpawn(
                'implementer',
                specTask,
                ctx.run.run_id,
                task.escalation_rung,
                'verify',
                e2eFeedbackNote(task),
                // D5 fix-forward: a prior blocked verify's confirmed reviewer blockers ∪
                // gate-stderr record (record.ts persisted it on the wait-retry branch) —
                // patches the specific verified misses instead of re-nuking.
                task.fix_findings
            )
        },

        /**
         * verify reporter: run the deterministic gates, then either spawn the
         * risk-invariant panel (no reviewers yet) or DERIVE the merge gate from the
         * already-recorded reviewers + gate evidence. Holdout evidence is recorded
         * separately by the orchestrator (the holdout-validator runs as an out-of-band holdout);
         * this reporter never spawns.
         */
        async verify(ctx: PhaseContext): Promise<PhaseResult> {
            const task = requireTask(ctx, 'verify')
            const worktree = taskWorktreePath(deps.dataDir, ctx.run.run_id, task.task_id)
            const gateCtx: GateContext = {
                runId: ctx.run.run_id,
                taskId: task.task_id,
                worktree,
                baseRef: ctx.run.staging_branch,
                config: deps.config,
                tools: deps.tools,
                exemptReader: taskExemptReader(deps, worktree),
                coverageStore: new FsCoverageStore(runCoverageDir(deps.dataDir, ctx.run.run_id)),
            }
            const gate = await new GateRunner().run(gateCtx)

            // Decision 51 — content-conditional DB specialist: derived from the diff
            // (never stored); record.ts re-derives from the same worktree tip.
            const dbApplicable = await touchesDatabase(deps.tools.git, gateCtx.baseRef, {cwd: worktree})
            const expectedRoster = panelRolesFor(dbApplicable)

            // S5/C — resolve the cross-vendor slot ONCE per spawn decision. In block
            // mode an absent second vendor cannot pass the merge gate, so fail fast
            // with an honest wait-retry INSTEAD of burning a full panel run.
            const panelSpawn = async (): Promise<PhaseResult> => {
                const crossVendor = await resolveCodexCrossVendor(deps.config.codex.model, deps.vendorProbe)
                if (deps.config.review.requireCrossVendor === 'block' && crossVendor.status === 'absent') {
                    return waitRetry(
                        'verify',
                        `cross-vendor reviewer required (review.requireCrossVendor=block) but absent: ${crossVendor.reason}`,
                        ctx.attempt ?? 1,
                        ESCALATION_CAP + 1
                    )
                }
                return spawn(
                    buildPanelManifest(
                        'verify',
                        resolveReviewModel(deps.config),
                        deps.config.review.maxTurnsDeep,
                        crossVendor,
                        dbApplicable
                    )
                )
            }

            // Fail-closed: re-spawn unless a FULL panel is on record. Guarding only the empty
            // roster let a persisted all-approve SUBSET (fewer reviewers than the expected
            // roster, e.g. from an unsanctioned write) derive a passing merge gate. Cardinality,
            // NOT identity: `reviewer` is a bare string whose format isn't proven equal to the
            // roster values, so an identity predicate risks a permanent re-spawn loop — a count
            // check catches the subset case and is footgun-free. The expected roster is the
            // Decision 51 content-conditional one (floor + DB specialist when applicable),
            // re-derived above from the same worktree tip record.ts derives from. The sanctioned
            // record path already runs enforcePanelRoster, so there's no known live trigger;
            // this is defense-in-depth.
            // ponytail: validates cardinality only; identity-validation needs the SpawnRole enum in
            // the state layer, which the frozen-seam rule forbids — deferred.
            if (task.reviewers.length < expectedRoster.length) {
                return panelSpawn()
            }

            // Fail-closed crash-resume guard: reviewers>0 here is the LEGITIMATE merge-resync
            // fast-path (reviewers persisted by the advance record; ship wait-retry re-enters via
            // exec→verify without clearing them). On every sanctioned route, holdout verdicts
            // already exist on disk before reviewers are persisted (the advance record reads them
            // LOUDLY). So for holdout tasks, missing verdicts imply an UNSANCTIONED write
            // (crash-window or rogue hook) — re-spawn the panel instead of deriving without
            // holdout evidence (fail-closed). Caveat: the store is task-keyed, not rung-keyed,
            // so a stale prior-rung verdict still satisfies the check (residual gap, tracked).
            const holdoutExpected = await deps.holdout.has(ctx.run.run_id, task.task_id)
            // Mutable evidence copy so we can append holdout gate below without mutating gate.evidence.
            const fastPathEvidence = [...gate.evidence]
            if (holdoutExpected) {
                const verdictStore = new FsHoldoutVerdictStore(deps.dataDir)
                const hasVerdicts = await verdictStore.has(ctx.run.run_id, task.task_id)
                if (!hasVerdicts) {
                    return panelSpawn()
                }
                // Re-derive holdout gate evidence for the fast-path. The normal composition site
                // is applyRecordReviews's deriveHoldoutEvidence call (record.ts), skipped on merge-resync.
                // Without this a re-synced implementation that fails withheld criteria can pass
                // the merge gate. deriveHoldoutEvidence() returns undefined if no record exists,
                // but holdoutExpected guarantees one does.
                const holdoutGate = await deriveHoldoutEvidence(
                    deps.holdout,
                    verdictStore,
                    ctx.run.run_id,
                    task.task_id,
                    deps.config.quality.holdoutPassRate
                )
                if (holdoutGate !== undefined) {
                    fastPathEvidence.push(holdoutGate)
                }
            }

            const mergeGate = deriveMergeGateVerdict({reviewers: task.reviewers}, fastPathEvidence)
            if (mergeGate.passed) {
                return advance('ship')
            }
            return waitRetry(
                'verify',
                // fastPathEvidence (not gate.evidence): includes the holdout gate that may be
                // the actual blocker, so the reason names the real cause instead of a generic fallback.
                mergeGateBlockReason(task.reviewers, fastPathEvidence),
                ctx.attempt ?? 1,
                ESCALATION_CAP + 1
            )
        },

        /**
         * ship — NOT served from this reporter. The orchestrator runs the stateful
         * {@link import("./ship.js").shipTask} directly (PR pointer writes + the live
         * MergeSerializer), since a reporter can neither write state nor merge; the
         * orchestrator intercepts `ship` before {@link import("./engine.js").runPhase} can
         * ever dispatch it here.
         *
         * This method exists ONLY to keep {@link PhaseHandlers} TOTAL — the engine's
         * exhaustive per-task phase switch (engine.ts) requires a handler for every
         * `TaskPhase`. Its body is a LOUD throw: routing `ship` through `runPhase` is a
         * programming error (it would re-open the PR with none of shipTask's state
         * writes), so it fails fast rather than silently drifting from the live path.
         * (`shipBody` / `specTaskOf` remain exported below — `ship.ts` is their caller.)
         */
        ship(_ctx: PhaseContext): Promise<PhaseResult> {
            throw new Error('ship is routed to shipTask; runPhase must never dispatch ship')
        },

        /**
         * finalize (run-level, terminal-by-construction): the pure {@link decideFinalize}
         * over the run's task-status map. Throws if any task is non-terminal (it must
         * never be called with in-flight work) — never spins.
         */
        finalize(ctx: PhaseContext): Promise<PhaseResult> {
            return Promise.resolve(decideFinalize(ctx.run))
        },
    }
}

/**
 * Resolve the DURABLE spec task for a run task id. LOUD when the spec drifts.
 * Module-scope + exported so the stateful {@link import("./ship.js").shipTask}
 * resolves the same way the reporters do (one source of truth for run/spec drift
 * detection).
 */
export function specTaskOf(spec: SpecManifest, taskId: string): SpecTask {
    const found = spec.tasks.find((t) => t.task_id === taskId)
    if (found === undefined) {
        throw new Error(`handlers: task '${taskId}' is not present in spec '${spec.spec_id}' — run/spec drift`)
    }
    return found
}

/** The task-PR body — a minimal, deterministic provenance header. */
export function shipBody(runId: string, specTask: SpecTask): string {
    return [
        `Factory task \`${specTask.task_id}\` — ${specTask.title}`,
        '',
        specTask.description,
        '',
        `Run: \`${runId}\``,
        `Risk tier: ${specTask.risk_tier}`,
    ].join('\n')
}
