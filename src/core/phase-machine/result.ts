/**
 * WS2 — {@link PhaseResult}: the engine↔orchestrator seam, a discriminated union
 * on the literal field `kind`.
 *
 * THE LOAD-BEARING PROPERTY: an unknown/unhandled `kind` is BOTH a compile-time
 * type error (the engine's exhaustive `switch` over `kind` has no default branch
 * that "advances") AND a runtime throw (via {@link assertNever}). A new variant
 * therefore cannot silently fall through to "advance" (cross-cutting invariant
 * #1). This is the structural successor to the bash exit-code contract — but the
 * mappings below are reference only, NOT ported:
 *
 *   bash rc 0  → "advance" / "task-terminal"(done)
 *   bash rc 10 → "spawn-agents"
 *   bash rc 2  → "graceful-stop"
 *   bash rc 3  → "wait-retry"   (BOUNDED here; FORBIDDEN in finalize — anti-spin)
 *   bash rc 30 → "task-terminal"(failed)
 *   bash rc 20 → DELETED (human gates retired, Decision 5 — no `human-gate` kind)
 *
 * Constructors below build well-formed variants so handlers/fakes never drift the
 * shape. The orchestrator (WS10), not the engine, ACTS on a result; the engine only
 * surfaces it after one structural exhaustiveness check (engine.ts).
 */
import type { TaskPhase } from "./phases.js";
import type { SpawnRequest } from "./spawn.js";
import type { FailureClass } from "../state/index.js";

/** Handler finished a phase with no spawn; advance to phase `to`. */
export interface AdvanceResult {
  kind: "advance";
  /** The phase the task advances TO (the resumed-at phase). */
  to: TaskPhase;
}

/** Handler needs subagents; spawn them and resume at `request.resume_phase`. */
export interface SpawnAgentsResult {
  kind: "spawn-agents";
  request: SpawnRequest;
}

/**
 * Quota breach — a GRACEFUL stop, never a fail (Decision 24). `"5h"` =
 * pause-in-place (RunStatus `paused`); `"7d"` = persist + exit (RunStatus
 * `suspended`). Optional `resets_at_epoch` is the resume horizon.
 */
export interface GracefulStopResult {
  kind: "graceful-stop";
  scope: "5h" | "7d";
  reason: string;
  resets_at_epoch?: number;
}

/**
 * Transient, BOUNDED retry: re-invoke the SAME phase. The engine throws if
 * `attempt > max_attempts` (engine.ts) — this can never spin. The task stays in
 * its current in-flight status.
 */
export interface WaitRetryResult {
  kind: "wait-retry";
  phase: TaskPhase;
  reason: string;
  attempt: number;
  max_attempts: number;
}

/**
 * A task reached a TERMINAL status. `done` (success) or `failed` + a CLOSED
 * {@link FailureClass} + a human-facing reason (Decision 22). The failed shape
 * mirrors the WS1 "failure_class set IFF failed" invariant.
 */
export interface TaskTerminalResult {
  kind: "task-terminal";
  outcome:
    | { outcome: "done" }
    | { outcome: "failed"; failure_class: FailureClass; reason: string };
}

/**
 * The run-level `finalize` result. ALWAYS terminal — there is deliberately no
 * `wait-retry` reachable from finalize (the explicit fix for the bash
 * `_stage_finalize_run` spin-bug). Two outcomes only (Decision 34): `completed`
 * = all tasks done; `failed` = any task failed or run could not finish.
 */
export interface FinalizeTerminalResult {
  kind: "finalize-terminal";
  run_status: "completed" | "failed";
}

/** The closed PhaseResult discriminated union (literal `kind`). */
export type PhaseResult =
  | AdvanceResult
  | SpawnAgentsResult
  | GracefulStopResult
  | WaitRetryResult
  | TaskTerminalResult
  | FinalizeTerminalResult;

// ---------------------------------------------------------------------------
// Exhaustiveness primitive
// ---------------------------------------------------------------------------

/**
 * The exhaustiveness primitive. Called in the `default` branch of a `switch` over
 * a closed union: if every case is handled, `x` narrows to `never` and this is
 * dead code (compile-time guarantee); if a case is missed OR an unknown `kind`
 * arrives at runtime, it THROWS loudly. This is invariant #1 — an unhandled kind
 * can never silently advance.
 */
export function assertNever(x: never): never {
  throw new Error(
    `assertNever: unhandled value ${JSON.stringify(x)} — a PhaseResult.kind was not handled`,
  );
}

// ---------------------------------------------------------------------------
// Constructors (so handlers/fakes build well-formed results without shape drift)
// ---------------------------------------------------------------------------

export function advance(to: TaskPhase): AdvanceResult {
  return { kind: "advance", to };
}

export function spawn(request: SpawnRequest): SpawnAgentsResult {
  return { kind: "spawn-agents", request };
}

export function gracefulStop(
  scope: "5h" | "7d",
  reason: string,
  resets_at_epoch?: number,
): GracefulStopResult {
  return resets_at_epoch === undefined
    ? { kind: "graceful-stop", scope, reason }
    : { kind: "graceful-stop", scope, reason, resets_at_epoch };
}

export function waitRetry(
  phase: TaskPhase,
  reason: string,
  attempt: number,
  max_attempts: number,
): WaitRetryResult {
  return { kind: "wait-retry", phase, reason, attempt, max_attempts };
}

export function taskDone(): TaskTerminalResult {
  return { kind: "task-terminal", outcome: { outcome: "done" } };
}

export function taskFailed(failure_class: FailureClass, reason: string): TaskTerminalResult {
  return {
    kind: "task-terminal",
    outcome: { outcome: "failed", failure_class, reason },
  };
}

export function finalizeTerminal(
  run_status: FinalizeTerminalResult["run_status"],
): FinalizeTerminalResult {
  return { kind: "finalize-terminal", run_status };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True iff the result ends a unit of work: a task reached terminal
 * (`task-terminal`), the run finalized (`finalize-terminal`), or the run stopped
 * gracefully on quota (`graceful-stop`). `advance`/`spawn-agents`/`wait-retry`
 * are continuations, not terminals.
 */
export function isTerminalResult(r: PhaseResult): boolean {
  switch (r.kind) {
    case "task-terminal":
    case "finalize-terminal":
    case "graceful-stop":
      return true;
    case "advance":
    case "spawn-agents":
    case "wait-retry":
      return false;
    default:
      return assertNever(r);
  }
}
