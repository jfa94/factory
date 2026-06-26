/**
 * WS10 — the STAGE HANDLERS (Model A REPORTERS).
 *
 * {@link makeStageHandlers} builds the {@link StageHandlers} the WS2 engine
 * dispatches. Per the Model-A split (types.ts), a handler is a pure-ish REPORTER:
 * it reads the frozen {@link StageContext}, does DETERMINISTIC work (shell out via
 * the injected git/gate clients, persist a holdout answer-key or a producer
 * prompt-context artifact), and RETURNS a {@link StageResult}. A handler NEVER
 * writes run state (the driver owns the StateManager), NEVER spawns an agent (it
 * reports a `spawn-agents` manifest the driver acts on), and NEVER decides a
 * transition beyond naming the stage it advances/resumes at.
 *
 * The producer escalation ladder is re-expressed PER INVOCATION off the persisted
 * `escalation_rung`: every producer-spawning stage reads `task.escalation_rung`,
 * dials the model + prior-failure injection for that rung ({@link dialForRung}),
 * and the DRIVER bumps the rung on a classified retry. There is no `runLadder`
 * call here — v1 re-expresses only the OUTER ladder via the persisted rung.
 *
 * VERIFY + SHIP. The `verify` reporter here derives the merge gate from the
 * already-recorded reviewers + gate evidence; it does NOT itself spawn the panel or
 * the holdout-validator (a handler cannot spawn). The coroutine emits those agents out of
 * band — the panel as the verify spawn manifest, the holdout-validator as a sidecar —
 * and records their results via the record cores. `ship` is NOT served from this reporter
 * at all: the coroutine runs the stateful {@link import("./ship.js").shipTask} (PR pointer
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
  resolveStagingBranch,
  GateRunner,
  buildPanelManifest,
  resolveReviewModel,
  dialForRung,
  buildProducerContext,
  ESCALATION_CAP,
  splitHoldout,
  makeHoldoutRecord,
  parseSpawnManifest,
  decideFinalize,
  type Config,
  type GateContext,
  type PriorFailureNote,
  type ProducerContext,
  type SpawnManifest,
  type SpecManifest,
  type SpecTask,
  type StageContext,
  type StageHandlers,
  type StageResult,
  type TaskStage,
  type TaskState,
} from "./deps.js";
import type { HandlerDeps } from "./types.js";
import { taskWorktreePath } from "./paths.js";
import { taskExemptReader } from "./exempt.js";
import { FsHoldoutVerdictStore } from "../verifier/holdout/index.js";

/**
 * A producer role the tests/exec reporters spawn. Mirrors the WS8
 * {@link import("./deps.js").ProducerRole} vocabulary; declared locally so the
 * manifest builder stays self-contained.
 */
type ProducerSpawnRole = "test-writer" | "executor";

/**
 * Build the {@link StageHandlers} bound to one reporter dependency bundle. Stateless
 * apart from the closure over `deps`; every method is idempotent given identical
 * frozen state + identical tool outputs.
 */
export function makeStageHandlers(deps: HandlerDeps): StageHandlers {
  // -- shared reporter helpers ---------------------------------------------

  /** The task the engine is acting on; absent only for the run-level finalize. */
  function requireTask(ctx: StageContext, stage: string): TaskState {
    if (ctx.task === undefined) {
      throw new Error(`handlers: stage '${stage}' requires a task but ctx.task is absent`);
    }
    return ctx.task;
  }

  /**
   * The deterministic holdout split for a task. Seeded with `${runId}:${taskId}` so
   * the tests stage (which PERSISTS the answer key) and the exec stage (which only
   * RECOMPUTES the visible remainder) independently derive the SAME partition.
   */
  function splitFor(config: Config, runId: string, specTask: SpecTask) {
    return splitHoldout(
      specTask.acceptance_criteria,
      config.quality.holdoutPercent,
      `${runId}:${specTask.task_id}`,
    );
  }

  /**
   * The prior-failure "don't do this" note injected on rung ≥ 2 (the rung-2 changed
   * variable, Decision 25). The reporter has only the persisted rung — not the
   * earlier verifier detail (that richer fix-forward signal is the loop's job, not
   * the v1 outer-ladder re-expression) — so it synthesizes a rung-keyed note. Its
   * PRESENCE is what makes {@link buildProducerContext} set `injectedPriorFailure`.
   */
  function priorFailureNote(rung: number): PriorFailureNote {
    const prior = Math.max(0, rung - 1);
    return {
      rung: prior,
      summary: `prior attempt at rung ${prior} did not clear the merge gate`,
    };
  }

  /**
   * Assemble + PERSIST a producer prompt-context for `(role, rung)` and return the
   * one-agent spawn manifest that resumes at `stageAfter`. The context is built from
   * the holdout-stripped `visibleCriteria` only; the prior-failure note is recorded in
   * IFF the dial injects it (rung ≥ 2).
   */
  async function producerSpawn(
    role: ProducerSpawnRole,
    specTask: SpecTask,
    runId: string,
    rung: number,
    stageAfter: TaskStage,
  ): Promise<StageResult> {
    const dial = dialForRung(specTask.risk_tier, rung, deps.config);
    const split = splitFor(deps.config, runId, specTask);
    const context: ProducerContext = buildProducerContext({
      taskId: specTask.task_id,
      title: specTask.title,
      description: specTask.description,
      visibleCriteria: split.visible,
      files: specTask.files,
      rung,
      priorFailures: dial.injectsPriorFailure ? [priorFailureNote(rung)] : [],
    });
    const promptRef = await deps.artifacts.putProducerContext(
      runId,
      specTask.task_id,
      `${role}-r${rung}`,
      context,
    );
    const manifest: SpawnManifest = parseSpawnManifest({
      stage_after: stageAfter,
      agents: [
        {
          role,
          model: dial.model,
          // No executor-specific turn budget exists; both producer roles share the
          // test-writer cap (documented WS10 decision).
          max_turns: deps.config.testWriter.maxTurns,
          prompt_ref: promptRef,
          // Effort is set ONLY once the dial has climbed the model to its ceiling
          // (rung ≥ 3 for sub-ceiling tasks, ≥ 2 for high-tier). Omitted ⇒ the agent
          // inherits the spawn default — never pass `effort: undefined`.
          ...(dial.effort !== undefined ? { effort: dial.effort } : {}),
        },
      ],
    });
    return spawn(manifest);
  }

  // -- stage reporters -----------------------------------------------------

  return {
    /**
     * preflight: create the per-task worktree forked off the staging tip (D12
     * base-is-staging-tip assertion lives inside createTaskWorktree), then advance
     * to the tests stage. The run-scoped branch is deterministic from (run, task),
     * so it is not threaded through state here — ship recomputes it.
     */
    async preflight(ctx: StageContext): Promise<StageResult> {
      const task = requireTask(ctx, "preflight");
      const worktree = taskWorktreePath(deps.dataDir, ctx.run.run_id, task.task_id);
      await createTaskWorktree({
        gitClient: deps.git,
        runId: ctx.run.run_id,
        taskId: task.task_id,
        path: worktree,
        base: resolveStagingBranch(ctx.run.run_id, ctx.run.staging_branch),
      });
      // Make the worktree runnable BEFORE the command-gates: install deps via the
      // configured setupCommand (else a lockfile-detected install). FAILS LOUD on a
      // bad env so it halts here, not as an opaque test/type/build gate failure.
      await (deps.provision ?? provisionWorktree)({
        path: worktree,
        setupCommand: deps.config.quality.setupCommand,
      });
      return advance("tests");
    },

    /**
     * tests: PERSIST the holdout answer-key (the only stage that does — exec merely
     * recomputes the split), then either skip the test-writer (tdd_exempt → advance
     * to exec) or spawn the test-writer for the current rung (resume at exec).
     */
    async tests(ctx: StageContext): Promise<StageResult> {
      const task = requireTask(ctx, "tests");
      const specTask = specTaskOf(deps.spec, task.task_id);

      // Persist the answer key once, regardless of TDD exemption — holdout
      // validation is independent of whether the producer wrote tests. A degenerate
      // split (withheld 0) persists nothing, so verify's `holdout.has` short-circuits.
      const split = splitFor(deps.config, ctx.run.run_id, specTask);
      if (split.withheld.length > 0) {
        await deps.holdout.put(
          ctx.run.run_id,
          makeHoldoutRecord(task.task_id, split.withheld, specTask.acceptance_criteria.length),
        );
      }

      if (specTask.tdd_exempt === true) {
        return advance("exec");
      }
      return producerSpawn("test-writer", specTask, ctx.run.run_id, task.escalation_rung, "exec");
    },

    /**
     * exec: spawn the executor for the current rung against the holdout-stripped
     * visible criteria (recomputed from the same seed — never re-persisted), resume
     * at verify.
     */
    async exec(ctx: StageContext): Promise<StageResult> {
      const task = requireTask(ctx, "exec");
      const specTask = specTaskOf(deps.spec, task.task_id);
      return producerSpawn("executor", specTask, ctx.run.run_id, task.escalation_rung, "verify");
    },

    /**
     * verify reporter: run the deterministic gates, then either spawn the
     * risk-invariant panel (no reviewers yet) or DERIVE the merge gate from the
     * already-recorded reviewers + gate evidence. Holdout evidence is recorded
     * separately by the coroutine (the holdout-validator runs as an out-of-band sidecar);
     * this reporter never spawns.
     */
    async verify(ctx: StageContext): Promise<StageResult> {
      const task = requireTask(ctx, "verify");
      const worktree = taskWorktreePath(deps.dataDir, ctx.run.run_id, task.task_id);
      const gateCtx: GateContext = {
        runId: ctx.run.run_id,
        taskId: task.task_id,
        worktree,
        baseRef: resolveStagingBranch(ctx.run.run_id, ctx.run.staging_branch),
        config: deps.config,
        tools: deps.tools,
        exemptReader: taskExemptReader(deps, worktree),
      };
      const gate = await new GateRunner().run(gateCtx);

      if (task.reviewers.length === 0) {
        return spawn(
          buildPanelManifest(
            "verify",
            resolveReviewModel(deps.config),
            deps.config.review.maxTurnsDeep,
          ),
        );
      }

      // Fail-closed crash-resume guard: reviewers>0 here is the LEGITIMATE merge-resync
      // fast-path (reviewers persisted by the advance record; ship wait-retry re-enters via
      // exec→verify without clearing them). On every sanctioned route, holdout verdicts
      // already exist on disk before reviewers are persisted (the advance record reads them
      // LOUDLY). So for holdout tasks, missing verdicts imply an UNSANCTIONED write
      // (crash-window or rogue hook) — re-spawn the panel instead of deriving without
      // holdout evidence (fail-closed). Caveat: the store is task-keyed, not rung-keyed,
      // so a stale prior-rung verdict still satisfies the check (residual gap, tracked).
      const holdoutExpected = await deps.holdout.has(ctx.run.run_id, task.task_id);
      if (holdoutExpected) {
        const verdictStore = new FsHoldoutVerdictStore(deps.dataDir);
        const hasVerdicts = await verdictStore.has(ctx.run.run_id, task.task_id);
        if (!hasVerdicts) {
          return spawn(
            buildPanelManifest(
              "verify",
              resolveReviewModel(deps.config),
              deps.config.review.maxTurnsDeep,
            ),
          );
        }
      }

      const mergeGate = deriveMergeGateVerdict({ reviewers: task.reviewers }, gate.evidence);
      if (mergeGate.passed) {
        return advance("ship");
      }
      return waitRetry(
        "verify",
        mergeGateBlockReason(task.reviewers, gate.evidence),
        ctx.attempt ?? 1,
        ESCALATION_CAP + 1,
      );
    },

    /**
     * ship — NOT served from this reporter. The coroutine runs the stateful
     * {@link import("./ship.js").shipTask} directly (PR pointer writes + the live
     * MergeSerializer), since a reporter can neither write state nor merge; the
     * coroutine intercepts `ship` before {@link import("./engine.js").runStage} can
     * ever dispatch it here.
     *
     * This method exists ONLY to keep {@link StageHandlers} TOTAL — the engine's
     * exhaustive per-task stage switch (engine.ts) requires a handler for every
     * `TaskStage`. Its body is a LOUD throw: routing `ship` through `runStage` is a
     * programming error (it would re-open the PR with none of shipTask's state
     * writes), so it fails fast rather than silently drifting from the live path.
     * (`shipBody` / `specTaskOf` remain exported below — `ship.ts` is their caller.)
     */
    ship(_ctx: StageContext): Promise<StageResult> {
      throw new Error("ship is routed to shipTask; runStage must never dispatch ship");
    },

    /**
     * finalize (run-level, terminal-by-construction): the pure {@link decideFinalize}
     * over the run's task-status map. Throws if any task is non-terminal (it must
     * never be called with in-flight work) — never spins.
     */
    finalize(ctx: StageContext): Promise<StageResult> {
      return Promise.resolve(decideFinalize(ctx.run));
    },
  };
}

/**
 * Resolve the DURABLE spec task for a run task id. LOUD when the spec drifts.
 * Module-scope + exported so the stateful {@link import("./ship.js").shipTask}
 * resolves the same way the reporters do (one source of truth for run/spec drift
 * detection).
 */
export function specTaskOf(spec: SpecManifest, taskId: string): SpecTask {
  const found = spec.tasks.find((t) => t.task_id === taskId);
  if (found === undefined) {
    throw new Error(
      `handlers: task '${taskId}' is not present in spec '${spec.spec_id}' — run/spec drift`,
    );
  }
  return found;
}

/** The task-PR body — a minimal, deterministic provenance header. */
export function shipBody(runId: string, specTask: SpecTask): string {
  return [
    `Factory task \`${specTask.task_id}\` — ${specTask.title}`,
    "",
    specTask.description,
    "",
    `Run: \`${runId}\``,
    `Risk tier: ${specTask.risk_tier}`,
  ].join("\n");
}
