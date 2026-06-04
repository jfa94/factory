/**
 * WS2 — {@link StageResult}: the engine↔orchestrator seam, a discriminated union
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
 *   bash rc 30 → "task-terminal"(dropped)
 *   bash rc 20 → DELETED (human gates retired, Decision 5 — no `human-gate` kind)
 *
 * Constructors below build well-formed variants so handlers/fakes never drift the
 * shape. The driver (WS10), not the engine, ACTS on a result; the engine only
 * surfaces it after one structural exhaustiveness check (engine.ts).
 */
import type { TaskStage } from "./stages.js";
import type { SpawnManifest } from "./manifest.js";
import type { FailureClass } from "../state/index.js";

/** Handler finished a stage with no spawn; advance to stage `to`. */
export interface AdvanceResult {
  kind: "advance";
  /** The stage the task advances TO (the resumed-at stage). */
  to: TaskStage;
}

/** Handler needs subagents; spawn them and resume at `manifest.stage_after`. */
export interface SpawnAgentsResult {
  kind: "spawn-agents";
  manifest: SpawnManifest;
}

/**
 * Quota breach — a GRACEFUL stop, never a drop (Decision 24). `"5h"` =
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
 * Transient, BOUNDED retry: re-invoke the SAME stage. The engine throws if
 * `attempt > max_attempts` (engine.ts) — this can never spin. The task stays in
 * its current in-flight status.
 */
export interface WaitRetryResult {
  kind: "wait-retry";
  stage: TaskStage;
  reason: string;
  attempt: number;
  max_attempts: number;
}

/**
 * A task reached a TERMINAL status. `done` (success) or `dropped` + a CLOSED
 * {@link FailureClass} + a human-facing reason (Decision 22). The dropped shape
 * mirrors the WS1 "failure_class set IFF dropped" invariant.
 */
export interface TaskTerminalResult {
  kind: "task-terminal";
  outcome:
    | { outcome: "done" }
    | { outcome: "dropped"; failure_class: FailureClass; reason: string };
}

/**
 * The run-level `finalize` result. ALWAYS terminal — there is deliberately no
 * `wait-retry` reachable from finalize (the explicit fix for the bash
 * `_stage_finalize_run` spin-bug). `partial` is the DEFAULT for an incomplete run
 * (≥1 dropped, ≥1 done); `completed` = all done; `failed` = nothing shippable.
 */
export interface FinalizeTerminalResult {
  kind: "finalize-terminal";
  run_status: "completed" | "partial" | "failed";
}

/** The closed StageResult discriminated union (literal `kind`). */
export type StageResult =
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
    `assertNever: unhandled value ${JSON.stringify(x)} — a StageResult.kind was not handled`,
  );
}

// ---------------------------------------------------------------------------
// Constructors (so handlers/fakes build well-formed results without shape drift)
// ---------------------------------------------------------------------------

export function advance(to: TaskStage): AdvanceResult {
  return { kind: "advance", to };
}

export function spawn(manifest: SpawnManifest): SpawnAgentsResult {
  return { kind: "spawn-agents", manifest };
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
  stage: TaskStage,
  reason: string,
  attempt: number,
  max_attempts: number,
): WaitRetryResult {
  return { kind: "wait-retry", stage, reason, attempt, max_attempts };
}

export function taskDone(): TaskTerminalResult {
  return { kind: "task-terminal", outcome: { outcome: "done" } };
}

export function taskDropped(failure_class: FailureClass, reason: string): TaskTerminalResult {
  return {
    kind: "task-terminal",
    outcome: { outcome: "dropped", failure_class, reason },
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
export function isTerminalResult(r: StageResult): boolean {
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
