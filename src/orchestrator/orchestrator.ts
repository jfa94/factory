/**
 * The per-task COROUTINE — the engine half of the `factory next-action` seam.
 *
 * One invocation = "run every deterministic step you can, then stop": the orchestrator
 * resumes at the persisted phase cursor, optionally FOLDS the previous spawn's
 * agent results (producer status / holdout raw / panel reviews — the internalized
 * record-* writers), then loops the phase machine until it either needs agents
 * (emit ONE spawn envelope and return) or the task is terminal.
 *
 * Re-invocation contract:
 *   - WITHOUT results: idempotent — the same spawn envelope re-derives from
 *     persisted state. Safe to retry after any crash.
 *   - WITH results: at-least-once delivery, exactly-once application. The
 *     result_key echoed from the spawn envelope is validated against the current
 *     cursor phase and escalation_rung before any mutation; stale or duplicate
 *     result delivery is rejected LOUD (never double-recorded). Caveat: the
 *     result_key is (phase, rung) not a nonce — a rescue cycle can reissue an
 *     identical key, so exactly-once holds under the realistic crash model (the
 *     orchestrator replays only the last unacknowledged delivery), not against
 *     arbitrarily delayed redelivery.
 *
 * Spawn-boundary inversion: instead of awaiting an injected agent runner in
 * process, the orchestrator RETURNS the spawn request to the caller (the runner)
 * and resumes on the next invocation by recording the collected results.
 * Holdout-before-reviews — an Iron Law the old skill enforced by prose — is here
 * mere code ordering inside recordResults.
 */
import {
  classifyFailure,
  isTerminalTaskStatus,
  runPhase,
  phaseToInFlightStatus,
  assertNever,
  type PhaseContext,
  type PhaseResult,
  type SpawnRequest,
  type StateManager,
  type TaskPhase,
  type TaskState,
  type RunState,
} from "./deps.js";
import type { UsageSignal } from "./deps.js";
import {
  markInFlight,
  completeTask,
  failStep,
  escalateOrFail,
  type TaskOutcome,
  type TaskStep,
} from "./transitions.js";
import {
  applyRecordProducer,
  applyRecordHoldout,
  applyRecordReviews,
  type RecordDeps,
} from "./record.js";
import { makePhaseHandlers } from "./handlers.js";
import { resolveStagingBranch } from "./deps.js";
import { shipTask } from "./ship.js";
import { taskWorktreePath } from "./paths.js";
import { applyQuotaGate, quotaStopFields, type QuotaStop } from "./quota-gate.js";
import { resolveReviewModel } from "../verifier/judgment/index.js";
import { buildHoldoutPrompt, FsHoldoutVerdictStore } from "../verifier/holdout/index.js";
import { isSpawnPhase } from "./results.js";
import type { DriveResults, ResultKey, SpawnPhase } from "./results.js";
import type { HandlerDeps } from "./types.js";
import { createLogger } from "../shared/index.js";

const log = createLogger("orchestrator");

export type { SpawnPhase };

/** Ship live-merge re-sync budget per task (persisted in TaskState.merge_resyncs). */
export const MERGE_RESYNC_CAP = 8;

/** What the orchestrator must collect for the emitted request. */
export type DriveExpects = "producer-status" | "reviews";

/** The out-of-band holdout-validator spawn run alongside the panel (verify only). */
export interface HoldoutSpawn {
  readonly kind: "holdout-validate";
  readonly task_id: string;
  readonly worktree: string;
  readonly model: string;
  readonly max_turns: number;
  readonly prompt: string;
}

export type NextAction =
  | {
      readonly kind: "spawn";
      readonly run_id: string;
      readonly task_id: string;
      readonly phase: SpawnPhase;
      readonly result_key: ResultKey;
      readonly request: SpawnRequest;
      readonly holdout?: HoldoutSpawn;
      readonly expects: DriveExpects;
      readonly worktree: string;
      /**
       * The per-run base ref the worktree forked from (`origin/staging-<run-id>`).
       * Reviewers + the holdout holdout diff against THIS — never a bare
       * `origin/staging`, which namespace-collides after a repo branch rename.
       */
      readonly base_ref: string;
    }
  | {
      readonly kind: "done";
      readonly run_id: string;
      readonly task_id: string;
      readonly outcome: TaskOutcome;
    }
  | {
      readonly kind: "pause";
      readonly run_id: string;
      readonly task_id: string;
      readonly scope: QuotaStop["scope"];
      readonly reason: string;
      readonly resets_at_epoch?: number;
    };

/** Everything the orchestrators need: the reporter bundle + state + the quota signal. */
export interface OrchestratorDeps extends HandlerDeps {
  readonly state: StateManager;
  readonly usage: UsageSignal;
  /** Epoch SECONDS. */
  readonly now: () => number;
  /** True iff the target repo keeps /docs and docs are not opted out (docs phase gate). */
  readonly docsApplicable: () => Promise<boolean>;
}

/** Resolve the live task row (LOUD if absent — run/spec drift). */
function requireTask(run: RunState, taskId: string): TaskState {
  const task = run.tasks[taskId];
  if (task === undefined) {
    throw new Error(`orchestrator: run '${run.run_id}' has no task '${taskId}'`);
  }
  return task;
}

/** The terminal outcome of an already-terminal task row (idempotent re-entry). */
function terminalOutcome(task: TaskState): TaskOutcome {
  if (task.status === "done") return { outcome: "done" };
  if (task.failure_class === undefined) {
    throw new Error(
      `orchestrator: terminal task '${task.task_id}' has no failure_class — schema invariant violated`,
    );
  }
  if (task.failure_reason === undefined) {
    throw new Error(
      `orchestrator: terminal task '${task.task_id}' has no failure_reason — schema invariant violated`,
    );
  }
  return {
    outcome: "failed",
    failure_class: task.failure_class,
    reason: task.failure_reason,
  };
}

/**
 * Assert that a TaskPhase is a SpawnPhase (tests|exec|verify). Preflight and
 * ship never emit spawn envelopes — this throw is structurally unreachable but
 * documents the invariant explicitly.
 */
function asSpawnPhase(phase: TaskPhase): SpawnPhase {
  if (isSpawnPhase(phase)) {
    return phase;
  }
  throw new Error(
    `orchestrator: phase '${phase}' cannot spawn agents (only tests|exec|verify can) — unreachable`,
  );
}

/** Build the holdout-validate holdout IFF an answer key was withheld for this task. */
export async function holdoutSidecar(
  deps: OrchestratorDeps,
  runId: string,
  taskId: string,
  baseRef: string,
): Promise<HoldoutSpawn | undefined> {
  if (!(await deps.holdout.has(runId, taskId))) {
    return undefined;
  }
  const record = await deps.holdout.get(runId, taskId);
  const worktree = taskWorktreePath(deps.dataDir, runId, taskId);
  return {
    kind: "holdout-validate",
    task_id: taskId,
    worktree,
    model: resolveReviewModel(deps.config),
    max_turns: deps.config.review.maxTurnsDeep,
    prompt: buildHoldoutPrompt(record, worktree, baseRef),
  };
}

/** Record the previous spawn's results into state via the shared writers. */
async function recordResults(
  deps: OrchestratorDeps,
  runId: string,
  taskId: string,
  phase: TaskPhase,
  task: TaskState,
  results: DriveResults,
): Promise<TaskStep> {
  // Validate result_key BEFORE any mutation: stale or duplicate results reject LOUD.
  const { result_key } = results;
  if (!isSpawnPhase(phase)) {
    throw new Error(`drive: results given but phase '${phase}' spawns no agents`);
  }
  const spawnPhase = phase;
  if (result_key.phase !== spawnPhase || result_key.rung !== task.escalation_rung) {
    throw new Error(
      `drive: stale or duplicate results (result_key ${result_key.phase}/${result_key.rung} vs cursor ${spawnPhase}/${task.escalation_rung}) — re-invoke without results to get the current envelope`,
    );
  }

  const record: RecordDeps = deps;
  if (phase === "tests" || phase === "exec") {
    if (results.producer === undefined) {
      throw new Error(`drive: phase '${phase}' expects producer-status results`);
    }
    const env = await applyRecordProducer(
      deps.state,
      runId,
      taskId,
      phase,
      results.producer.status,
    );
    return env.step;
  }
  // phase === "verify" (checked above via isSpawnPhase)
  if (results.reviews === undefined) {
    throw new Error("drive: phase 'verify' expects reviews results");
  }
  // Holdout-required guard: if a withheld answer key exists but no holdout results
  // were delivered, reject LOUD. Silently reusing the previous rung's verdict would
  // bypass the holdout gate for the current escalation cycle.
  if ((await deps.holdout.has(runId, taskId)) && results.holdout === undefined) {
    throw new Error(
      `drive: task '${taskId}' has a withheld holdout answer key — verify results must ` +
        `include the holdout-validate raw output (results.holdout is missing)`,
    );
  }
  const verdictStore = new FsHoldoutVerdictStore(deps.dataDir);
  // Holdout BEFORE reviews — the record ordering the old skill enforced by prose.
  if (results.holdout !== undefined) {
    await applyRecordHoldout(record, runId, taskId, verdictStore, results.holdout.raw);
  }
  const env = await applyRecordReviews(record, runId, taskId, verdictStore, results.reviews);
  return env.step;
}

/**
 * Step one task: record results (if given), then run deterministic phases until a
 * spawn is needed or the task is terminal. See the module doc for the contract.
 */
export async function nextAction(
  deps: OrchestratorDeps,
  runId: string,
  taskId: string,
  results?: DriveResults,
): Promise<NextAction> {
  // 1. Read state + terminal check BEFORE the quota gate — a terminal task needs no
  //    agent spend and must not write a pause checkpoint (quota gate is a state write).
  let run = await deps.state.read(runId);
  let task = requireTask(run, taskId);

  if (isTerminalTaskStatus(task.status)) {
    return { kind: "done", run_id: runId, task_id: taskId, outcome: terminalOutcome(task) };
  }

  // 2. Quota gate — a breach persists the checkpoint and stops cleanly. Only reached
  //    for non-terminal tasks so the checkpoint is always meaningful. --ignore-quota
  //    skips pacing (Decision 24).
  const stop = await applyQuotaGate(deps, runId, run.ignore_quota);
  if (stop !== null) {
    return { kind: "pause", run_id: runId, task_id: taskId, ...quotaStopFields(stop) };
  }

  let phase: TaskPhase = task.phase ?? "preflight";

  // Tracks whether the cursor for `phase` is ALREADY persisted, so the loop's
  // markInFlight is skipped when a record (below) just wrote the identical cursor —
  // avoiding a duplicate locked RMW + fsync per record. An advance/re-route inside
  // the loop sets it back to false (the new phase's cursor is not yet written).
  let cursorPersisted = false;

  // 3. Record the previous spawn's results (validated against the cursor's phase + rung).
  if (results !== undefined) {
    const step = await recordResults(deps, runId, taskId, phase, task, results);
    if (step.done) {
      return { kind: "done", run_id: runId, task_id: taskId, outcome: step.outcome };
    }
    phase = step.phase;
    // recordResults persists the resume cursor for a non-terminal step (via
    // persistStepCursor or applyRecordReviews' advance-write), so it is current.
    cursorPersisted = true;
  }

  // 4. The deterministic phase loop — run a handler, record its result, advance the
  //    cursor; the only break is a spawn (boundary inverted: return the request).
  const handlers = makePhaseHandlers(deps);
  for (;;) {
    // Write the cursor only when it is not already current; either way obtain the
    // fresh RunState (markInFlight returns it; otherwise a lock-free read).
    run = cursorPersisted
      ? await deps.state.read(runId)
      : await markInFlight(deps, runId, taskId, phase);
    cursorPersisted = true;
    task = requireTask(run, taskId);
    const ctx: PhaseContext = { run, task, attempt: task.escalation_rung + 1 };

    const result: PhaseResult =
      phase === "ship" ? await shipTask(deps, ctx) : await runPhase(phase, ctx, handlers);

    switch (result.kind) {
      case "advance": {
        phase = result.to;
        cursorPersisted = false; // new phase's cursor not yet written
        continue;
      }
      case "spawn-agents": {
        const spawnPhase = asSpawnPhase(phase);
        const expects: DriveExpects = spawnPhase === "verify" ? "reviews" : "producer-status";
        const worktree = taskWorktreePath(deps.dataDir, runId, taskId);
        // The base ref the worktree forked from — plumbed into every spawn so
        // reviewers/holdout diff the per-run staging branch, not a bare `origin/staging`.
        const base_ref = `origin/${resolveStagingBranch(runId, run.staging_branch)}`;
        const holdout =
          spawnPhase === "verify" ? await holdoutSidecar(deps, runId, taskId, base_ref) : undefined;
        const result_key: ResultKey = { phase: spawnPhase, rung: task.escalation_rung };
        // WS2 idempotent re-spawn. Producers commit to the SHARED task worktree, so a
        // stop in the post-spawn / pre-record window strands the abandoned producer's
        // partial commits + uncommitted edits on the task branch. On the resume that
        // re-enters this SAME (phase, rung) before any results were recorded,
        // `spawn_in_flight` still names THIS spawn → reset the worktree to the tip we
        // captured at the original emit (prior completed phases live BELOW that tip and
        // survive), discarding only the interrupted phase's work, then re-spawn clean.
        // A fresh spawn instead CAPTURES the current tip. A stale checkpoint can never
        // match because every forward edge changes (phase, rung): advance moves the
        // phase, escalate bumps the rung, and the ship→exec re-sync lands on exec while
        // the checkpoint still names verify. Verify spawns read-only reviewers in their
        // own isolated worktrees, so HEAD never moved and the reset is a no-op. Terminal
        // writers (complete/fail) clear it; recording need not (the (phase, rung) change
        // already shields it), so this stays the lone live read of the field.
        // Gated on the worktree existing: past preflight every producer/verify spawn
        // has one, so this is true in any real run. When it is ABSENT (a degenerate
        // pre-preflight state) no producer has committed, so there is nothing to
        // checkpoint or reset — skip rather than shell out to git against a missing dir.
        if (await deps.git.worktreeExists(worktree)) {
          const inFlight = task.spawn_in_flight;
          if (
            inFlight !== undefined &&
            inFlight.phase === spawnPhase &&
            inFlight.rung === task.escalation_rung
          ) {
            await deps.git.resetHardClean(inFlight.tip_sha, { cwd: worktree });
          } else {
            const tip_sha = await deps.git.revParse("HEAD", { cwd: worktree });
            await deps.state.updateTask(runId, taskId, (t) => ({
              ...t,
              spawn_in_flight: { phase: spawnPhase, rung: t.escalation_rung, tip_sha },
            }));
          }
        }
        return {
          kind: "spawn",
          run_id: runId,
          task_id: taskId,
          phase: spawnPhase,
          result_key,
          request: result.request,
          ...(holdout !== undefined ? { holdout } : {}),
          expects,
          worktree,
          base_ref,
        };
      }
      case "task-terminal": {
        if (result.outcome.outcome === "done") {
          const step = await completeTask(deps, runId, taskId);
          if (!step.done) throw new Error("orchestrator: completeTask returned non-terminal step");
          return { kind: "done", run_id: runId, task_id: taskId, outcome: step.outcome };
        }
        const step = await failStep(
          deps,
          runId,
          taskId,
          result.outcome.failure_class,
          result.outcome.reason,
        );
        if (!step.done) throw new Error("orchestrator: failStep returned non-terminal step");
        return { kind: "done", run_id: runId, task_id: taskId, outcome: step.outcome };
      }
      case "wait-retry": {
        if (result.phase === "ship") {
          // Live-merge refusal → bounded re-sync through exec (persisted budget).
          // Bump merge_resyncs AND move the cursor to exec in ONE atomic write, so a
          // crash between the bump and the next markInFlight cannot double-spend the
          // budget (old code committed the bump under phase "ship", then markInFlight
          // separately wrote the exec cursor — a crash in that window replayed ship
          // and re-bumped). The capped check runs inside the mutator against the
          // committed value, never a stale pre-read. Over-cap is a terminal failure and
          // deliberately leaves the cursor at "ship" (the failure is the next write,
          // idempotent on resume) so a crash-during-fail doesn't re-run exec+verify
          // and re-spend agent budget.
          let newResyncs = 0;
          let overCap = false;
          await deps.state.updateTask(runId, taskId, (t) => {
            newResyncs = t.merge_resyncs + 1;
            overCap = newResyncs > MERGE_RESYNC_CAP;
            if (overCap) return { ...t, merge_resyncs: newResyncs };
            return {
              ...t,
              merge_resyncs: newResyncs,
              phase: "exec",
              status: phaseToInFlightStatus("exec"),
            };
          });
          if (overCap) {
            const step = await failStep(
              deps,
              runId,
              taskId,
              "blocked-environmental",
              `serial-merge re-sync budget (${MERGE_RESYNC_CAP}) exhausted: ${result.reason}`,
            );
            if (!step.done) throw new Error("orchestrator: failStep returned non-terminal step");
            return { kind: "done", run_id: runId, task_id: taskId, outcome: step.outcome };
          }
          log.info(
            `task '${taskId}' merge refused (${result.reason}); re-routing to exec to re-sync ` +
              `(attempt ${newResyncs}/${MERGE_RESYNC_CAP})`,
          );
          phase = "exec";
          cursorPersisted = true; // exec cursor written ATOMICALLY with the bump above
          continue;
        }
        // verify merge gate blocked on a crash-resume replay → same classify path as the record.
        const step = await escalateOrFail(
          deps,
          runId,
          taskId,
          classifyFailure({ kind: "merge-gate-blocked", reason: result.reason }),
          "exec",
        );
        if (step.done) {
          return { kind: "done", run_id: runId, task_id: taskId, outcome: step.outcome };
        }
        phase = step.phase;
        cursorPersisted = false; // escalateOrFail wrote rung+reviewers, not the cursor
        continue;
      }
      case "graceful-stop":
      case "finalize-terminal":
        throw new Error(`orchestrator: run-scope result '${result.kind}' surfaced at task scope`);
      default:
        return assertNever(result);
    }
  }
}
