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
 * VERIFY + SHIP duality. The `verify`/`ship` methods here are the CLI single-step
 * REPORTERS (`factory run-task --stage verify|ship`) and deliberately do LESS than
 * the in-process loop: `verify` folds NO holdout evidence (a holdout-validate spawn
 * is loop-owned — a handler cannot spawn), and `ship` opens the PR idempotently but
 * does not merge (the MergeSerializer is loop-owned). The in-process driver
 * (loop.ts) special-cases both stages with `runVerify`/`runShip` instead of calling
 * these. That divergence is structural and accepted; full CLI holdout/merge wiring
 * lands in Task C.
 */
import {
  advance,
  spawn,
  taskDone,
  waitRetry,
  deriveFloorVerdict,
  createTaskWorktree,
  createTaskPrIdempotent,
  runScopedBranch,
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
  type GateEvidence,
  type PriorFailureNote,
  type ProducerContext,
  type ReviewerResult,
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
      summary: `prior attempt at rung ${prior} did not clear the verifier floor`,
    };
  }

  /**
   * Assemble + PERSIST a producer prompt-context for `(role, rung)` and return the
   * one-agent spawn manifest that resumes at `stageAfter`. The context is built from
   * the holdout-stripped `visibleCriteria` only; the prior-failure note is folded in
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
      await createTaskWorktree({
        gitClient: deps.git,
        runId: ctx.run.run_id,
        taskId: task.task_id,
        path: taskWorktreePath(deps.dataDir, ctx.run.run_id, task.task_id),
        base: deps.config.git.stagingBranch,
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
     * verify (CLI single-step reporter — NO holdout): run the deterministic gates,
     * then either spawn the risk-invariant panel (no reviewers yet) or DERIVE the
     * floor from the already-recorded reviewers + gate evidence. The in-process loop
     * uses `runVerify` instead (which additionally folds holdout evidence).
     */
    async verify(ctx: StageContext): Promise<StageResult> {
      const task = requireTask(ctx, "verify");
      const gateCtx: GateContext = {
        runId: ctx.run.run_id,
        taskId: task.task_id,
        worktree: taskWorktreePath(deps.dataDir, ctx.run.run_id, task.task_id),
        baseRef: deps.config.git.stagingBranch,
        config: deps.config,
        tools: deps.tools,
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

      const floor = deriveFloorVerdict({ reviewers: task.reviewers }, gate.evidence);
      if (floor.passed) {
        return advance("ship");
      }
      return waitRetry(
        "verify",
        floorBlockReason(task.reviewers, gate.evidence),
        ctx.attempt ?? 1,
        ESCALATION_CAP + 1,
      );
    },

    /**
     * ship (CLI single-step reporter): open the task PR into staging IDEMPOTENTLY
     * (look up by head first — Δ P), then mark the task done. Merge is loop-owned
     * (MergeSerializer) and not performed here; `pr_number` recording is the
     * driver's job (the reporter cannot write state).
     */
    async ship(ctx: StageContext): Promise<StageResult> {
      const task = requireTask(ctx, "ship");
      const specTask = specTaskOf(deps.spec, task.task_id);
      const branch = runScopedBranch(ctx.run.run_id, task.task_id);
      await createTaskPrIdempotent({
        ghClient: deps.gh,
        branch,
        title: specTask.title,
        body: shipBody(ctx.run.run_id, specTask),
        base: deps.config.git.stagingBranch,
      });
      return taskDone();
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

/** A human-facing reason summarising why the verifier floor is blocked. */
function floorBlockReason(
  reviewers: readonly ReviewerResult[],
  gateEvidence: readonly GateEvidence[],
): string {
  const parts: string[] = [];
  const blocked = reviewers.filter((r) => r.verdict === "blocked").map((r) => r.reviewer);
  const errored = reviewers.filter((r) => r.verdict === "error").map((r) => r.reviewer);
  const failedGates = gateEvidence.filter((e) => !e.observed).map((e) => e.gate);
  if (failedGates.length > 0) parts.push(`gates failed: ${failedGates.join(", ")}`);
  if (blocked.length > 0) parts.push(`blocked by: ${blocked.join(", ")}`);
  if (errored.length > 0) parts.push(`unresolved (verifier error): ${errored.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : "verifier floor not unanimous";
}

/**
 * Resolve the DURABLE spec task for a run task id. LOUD when the spec drifts.
 * Module-scope + exported so the loop-owned `runShip` resolves the same way the
 * reporters do (one source of truth for run/spec drift detection).
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
