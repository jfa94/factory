/**
 * WS2 — the PURE stage engine.
 *
 * It validates the requested stage, calls the matching {@link StageHandlers}
 * method, and returns the handler's {@link StageResult} after ONE structural
 * exhaustiveness check (a `switch` over `result.kind` whose `default` calls
 * {@link assertNever}). It does NOT:
 *   - shell out (handlers do),
 *   - read/write state.json (the driver does, via WS1 StateManager),
 *   - sleep or loop.
 *
 * Two load-bearing guarantees:
 *   1. UNKNOWN KIND THROWS. The exhaustive switch makes a missing case a compile
 *      error and an unknown runtime `kind` a loud throw — never a silent advance.
 *   2. BOUNDED wait-retry. A `wait-retry` with `attempt > max_attempts` THROWS,
 *      forcing the caller to classify a drop. The engine cannot spin.
 *
 * The engine surfaces decisions; the DRIVER (WS10) acts on them. {@link nextStageFor}
 * computes the resume stage for `advance`/`spawn-agents` so the v1 session driver
 * and the v2 Workflow driver share the transition logic.
 */
import { TaskStageEnum, RunStageEnum, type TaskStage, type RunStage } from "./stages.js";
import {
  assertNever,
  finalizeTerminal,
  type FinalizeTerminalResult,
  type StageResult,
} from "./result.js";
import type { StageContext, StageHandlers } from "./handlers.js";
import { isTerminalTaskStatus, type RunState } from "../state/index.js";

/** Any stage the engine can run: a per-task stage or the run-level finalize. */
export type EngineStage = TaskStage | RunStage;

/**
 * Run one stage: dispatch to the matching handler, then run the result through the
 * exhaustiveness check. Returns the handler's result unchanged on a known kind;
 * THROWS on an unknown kind (invariant #1) or an out-of-bounds `wait-retry`
 * (invariant #2).
 *
 * A run-level (finalize) stage may return ONLY `finalize-terminal` (anti-spin):
 * any other kind throws here. Symmetrically, a per-task stage may never return
 * `finalize-terminal` — that result is reserved for the run-level stage.
 */
export async function runStage(
  stage: EngineStage,
  ctx: StageContext,
  handlers: StageHandlers,
): Promise<StageResult> {
  const result = await dispatch(stage, ctx, handlers);
  return checkResult(stage, result);
}

/** Select + call the handler for `stage`. Loud on an unknown stage value. */
async function dispatch(
  stage: EngineStage,
  ctx: StageContext,
  handlers: StageHandlers,
): Promise<StageResult> {
  // Run-level stage first (separate enum). Switch exhaustively over the parsed
  // RunStage so a NEW run-level member is a COMPILE break here, not a silent
  // mis-route to finalize (invariant #1 — no unhandled stage falls through).
  const runParsed = RunStageEnum.safeParse(stage);
  if (runParsed.success) {
    const runStageName: RunStage = runParsed.data;
    switch (runStageName) {
      case "finalize":
        return handlers.finalize(ctx);
      default:
        return assertNever(runStageName);
    }
  }
  const parsed = TaskStageEnum.safeParse(stage);
  if (!parsed.success) {
    throw new Error(`runStage: unknown stage '${String(stage)}'`);
  }
  const taskStage: TaskStage = parsed.data;
  switch (taskStage) {
    case "preflight":
      return handlers.preflight(ctx);
    case "tests":
      return handlers.tests(ctx);
    case "exec":
      return handlers.exec(ctx);
    case "verify":
      return handlers.verify(ctx);
    case "ship":
      return handlers.ship(ctx);
    default:
      return assertNever(taskStage);
  }
}

/**
 * The single structural check every handler result passes through. The exhaustive
 * switch is the compile-time exhaustiveness guarantee; `assertNever` is the
 * runtime guarantee. Enforces the bounded-wait-retry and no-wait-retry-in-finalize
 * invariants.
 */
function checkResult(stage: EngineStage, result: StageResult): StageResult {
  // A run-level stage (finalize today) is TERMINAL-BY-CONSTRUCTION: the only legal
  // result is `finalize-terminal`. advance / spawn-agents / graceful-stop /
  // task-terminal / wait-retry would each (re)enter the per-task loop or spin —
  // reject every one. This is the structural fix for the bash exit-3 finalize
  // spin-bug, generalized past the old wait-retry-only guard.
  if (RunStageEnum.safeParse(stage).success) {
    if (result.kind !== "finalize-terminal") {
      throw new Error(
        `runStage: run-level stage '${String(stage)}' returned '${result.kind}' — ` +
          `finalize is terminal and must return only 'finalize-terminal' (it must never spin)`,
      );
    }
    return result;
  }

  // Per-task stage: every kind EXCEPT finalize-terminal is legal (finalize-terminal
  // is reserved for the run-level stage above). wait-retry is additionally bounded.
  switch (result.kind) {
    case "advance":
    case "spawn-agents":
    case "graceful-stop":
    case "task-terminal":
      return result;
    case "wait-retry": {
      if (result.attempt > result.max_attempts) {
        throw new Error(
          `runStage: wait-retry for stage '${result.stage}' exceeded max_attempts ` +
            `(${result.attempt} > ${result.max_attempts}); caller must classify a drop (reason: ${result.reason})`,
        );
      }
      return result;
    }
    case "finalize-terminal":
      throw new Error(
        `runStage: per-task stage '${String(stage)}' returned 'finalize-terminal' — ` +
          `that result is reserved for the run-level finalize stage`,
      );
    default:
      return assertNever(result);
  }
}

/**
 * Given an `advance` or `spawn-agents` result, the stage the engine RESUMES at.
 * For `advance` it is `result.to`; for `spawn-agents` it is `manifest.stage_after`.
 * Returns `null` for any result that does not imply a resume stage (terminals,
 * graceful-stop, wait-retry — wait-retry re-runs its OWN `stage`, surfaced by the
 * caller directly). Shared by both drivers so transition logic lives in one place.
 */
export function nextStageFor(result: StageResult): TaskStage | null {
  switch (result.kind) {
    case "advance":
      return result.to;
    case "spawn-agents":
      return result.manifest.stage_after;
    case "wait-retry":
    case "graceful-stop":
    case "task-terminal":
    case "finalize-terminal":
      return null;
    default:
      return assertNever(result);
  }
}

/**
 * Thin class wrapper over {@link runStage} for callers that prefer to bind the
 * handler set once. Holds no mutable state — purely a closure over `handlers`.
 */
export class StageEngine {
  constructor(private readonly handlers: StageHandlers) {}

  /** See {@link runStage}. */
  run(stage: EngineStage, ctx: StageContext): Promise<StageResult> {
    return runStage(stage, ctx, this.handlers);
  }

  /** See {@link nextStageFor}. */
  nextStageFor(result: StageResult): TaskStage | null {
    return nextStageFor(result);
  }
}

// ---------------------------------------------------------------------------
// Finalize decision (pure, terminal-by-construction)
// ---------------------------------------------------------------------------

/**
 * The pure finalize decision over the run's task-status map. ALWAYS returns a
 * terminal {@link FinalizeTerminalResult} — there is NO `wait-retry` path (the
 * explicit fix for the bash `_stage_finalize_run` spin-bug, which returned rc 3 on
 * any non-done task).
 *
 * Rules (Decision 22 partial-rollup; `partial` is the DEFAULT for an incomplete
 * but resolved run):
 *   - every task `done`                       → `completed`
 *   - ≥1 `done` AND ≥1 `dropped` (all terminal) → `partial`
 *   - 0 `done` (nothing shippable)            → `failed`
 *
 * A non-terminal task remaining is a PROGRAMMING ERROR (finalize is only called
 * once the per-task loop has driven every task terminal). It THROWS loudly — it
 * does NOT return `wait-retry`. This structurally prevents the spin. A run with
 * zero tasks is `failed` (nothing was shippable).
 *
 * Real and fake `finalize` handlers both call this so finalize behaviour has ONE
 * home.
 */
export function decideFinalize(run: RunState): FinalizeTerminalResult {
  const tasks = Object.values(run.tasks);

  const nonTerminal = tasks.filter((t) => !isTerminalTaskStatus(t.status));
  if (nonTerminal.length > 0) {
    const ids = nonTerminal.map((t) => `${t.task_id}=${t.status}`).join(", ");
    throw new Error(
      `decideFinalize: ${nonTerminal.length} non-terminal task(s) remain [${ids}] — ` +
        `finalize is terminal and must not be called with in-flight work (would spin in bash)`,
    );
  }

  const doneCount = tasks.filter((t) => t.status === "done").length;
  if (doneCount === 0) {
    return finalizeTerminal("failed");
  }
  if (doneCount === tasks.length) {
    return finalizeTerminal("completed");
  }
  return finalizeTerminal("partial");
}
