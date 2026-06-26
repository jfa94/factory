/**
 * WS2 — the PURE phase engine.
 *
 * It validates the requested phase, calls the matching {@link PhaseHandlers}
 * method, and returns the handler's {@link PhaseResult} after ONE structural
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
 *      forcing the caller to classify a fail. The engine cannot spin.
 *
 * The engine surfaces decisions; the DRIVER (WS10) acts on them. {@link nextPhaseFor}
 * computes the resume phase for `advance`/`spawn-agents` so the v1 session driver
 * and the v2 Workflow driver share the transition logic.
 */
import { TaskPhaseEnum, RunPhaseEnum, type TaskPhase, type RunPhase } from "./phases.js";
import {
  assertNever,
  finalizeTerminal,
  type FinalizeTerminalResult,
  type PhaseResult,
} from "./result.js";
import type { PhaseContext, PhaseHandlers } from "./handlers.js";
import { isTerminalTaskStatus, type RunState } from "../state/index.js";

/** Any phase the engine can run: a per-task phase or the run-level finalize. */
export type EnginePhase = TaskPhase | RunPhase;

/**
 * Run one phase: dispatch to the matching handler, then run the result through the
 * exhaustiveness check. Returns the handler's result unchanged on a known kind;
 * THROWS on an unknown kind (invariant #1) or an out-of-bounds `wait-retry`
 * (invariant #2).
 *
 * A run-level (finalize) phase may return ONLY `finalize-terminal` (anti-spin):
 * any other kind throws here. Symmetrically, a per-task phase may never return
 * `finalize-terminal` — that result is reserved for the run-level phase.
 */
export async function runPhase(
  phase: EnginePhase,
  ctx: PhaseContext,
  handlers: PhaseHandlers,
): Promise<PhaseResult> {
  const result = await dispatch(phase, ctx, handlers);
  return checkResult(phase, result);
}

/** Select + call the handler for `phase`. Loud on an unknown phase value. */
async function dispatch(
  phase: EnginePhase,
  ctx: PhaseContext,
  handlers: PhaseHandlers,
): Promise<PhaseResult> {
  // Run-level phase first (separate enum). Switch exhaustively over the parsed
  // RunPhase so a NEW run-level member is a COMPILE break here, not a silent
  // mis-route to finalize (invariant #1 — no unhandled phase falls through).
  const runParsed = RunPhaseEnum.safeParse(phase);
  if (runParsed.success) {
    const runPhaseName: RunPhase = runParsed.data;
    switch (runPhaseName) {
      case "finalize":
        return handlers.finalize(ctx);
      default:
        return assertNever(runPhaseName);
    }
  }
  const parsed = TaskPhaseEnum.safeParse(phase);
  if (!parsed.success) {
    throw new Error(`runPhase: unknown phase '${String(phase)}'`);
  }
  const taskPhase: TaskPhase = parsed.data;
  switch (taskPhase) {
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
      return assertNever(taskPhase);
  }
}

/**
 * The single structural check every handler result passes through. The exhaustive
 * switch is the compile-time exhaustiveness guarantee; `assertNever` is the
 * runtime guarantee. Enforces the bounded-wait-retry and no-wait-retry-in-finalize
 * invariants.
 */
function checkResult(phase: EnginePhase, result: PhaseResult): PhaseResult {
  // A run-level phase (finalize today) is TERMINAL-BY-CONSTRUCTION: the only legal
  // result is `finalize-terminal`. advance / spawn-agents / graceful-stop /
  // task-terminal / wait-retry would each (re)enter the per-task loop or spin —
  // reject every one. This is the structural fix for the bash exit-3 finalize
  // spin-bug, generalized past the old wait-retry-only guard.
  if (RunPhaseEnum.safeParse(phase).success) {
    if (result.kind !== "finalize-terminal") {
      throw new Error(
        `runPhase: run-level phase '${String(phase)}' returned '${result.kind}' — ` +
          `finalize is terminal and must return only 'finalize-terminal' (it must never spin)`,
      );
    }
    return result;
  }

  // Per-task phase: every kind EXCEPT finalize-terminal is legal (finalize-terminal
  // is reserved for the run-level phase above). wait-retry is additionally bounded.
  switch (result.kind) {
    case "advance":
    case "spawn-agents":
    case "graceful-stop":
    case "task-terminal":
      return result;
    case "wait-retry": {
      if (result.attempt > result.max_attempts) {
        throw new Error(
          `runPhase: wait-retry for phase '${result.phase}' exceeded max_attempts ` +
            `(${result.attempt} > ${result.max_attempts}); caller must classify a fail (reason: ${result.reason})`,
        );
      }
      return result;
    }
    case "finalize-terminal":
      throw new Error(
        `runPhase: per-task phase '${String(phase)}' returned 'finalize-terminal' — ` +
          `that result is reserved for the run-level finalize phase`,
      );
    default:
      return assertNever(result);
  }
}

/**
 * Given an `advance` or `spawn-agents` result, the phase the engine RESUMES at.
 * For `advance` it is `result.to`; for `spawn-agents` it is `request.resume_phase`.
 * Returns `null` for any result that does not imply a resume phase (terminals,
 * graceful-stop, wait-retry — wait-retry re-runs its OWN `phase`, surfaced by the
 * caller directly). Shared by both drivers so transition logic lives in one place.
 */
export function nextPhaseFor(result: PhaseResult): TaskPhase | null {
  switch (result.kind) {
    case "advance":
      return result.to;
    case "spawn-agents":
      return result.request.resume_phase;
    case "wait-retry":
    case "graceful-stop":
    case "task-terminal":
    case "finalize-terminal":
      return null;
    default:
      return assertNever(result);
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
 * Rules (Decision 34 — whole-PRD delivery only; no partial rollup):
 *   - every task `done`                       → `completed`
 *   - any task not `done` (failed, etc.)     → `failed` (develop gets nothing)
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

  // Every task terminal (asserted above). Whole-PRD delivery only: all done => completed,
  // otherwise => failed (Decision 34 — develop receives only complete PRDs; no partial rollup).
  // tasks.length > 0 guards the vacuous-truth of Array.every on an empty array.
  const allDone = tasks.length > 0 && tasks.every((t) => t.status === "done");
  return finalizeTerminal(allDone ? "completed" : "failed");
}
