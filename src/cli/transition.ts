/**
 * Shared plumbing for the state-write subcommands (`advance` / `drop` /
 * `record-producer` / `record-reviews`).
 *
 * These subcommands are the ONLY sanctioned way the in-session orchestrator mutates
 * run state between single-steps (Model A): each folds an out-of-band agent outcome
 * (or an explicit transition) into the persisted task via the SHARED
 * {@link import("../driver/index.js").transitions} logic, then emits ONE
 * {@link TransitionEnvelope} naming the resulting {@link TaskStep}. The orchestrator
 * reads the step and either runs the next `factory run-task --stage <step.stage>` or
 * stops (a terminal `done`/`dropped`).
 */
import { readFile } from "node:fs/promises";
import { markInFlight, type TaskStep } from "../driver/index.js";
import { parseJson } from "../shared/json.js";
import type { StateManager } from "../core/state/index.js";

/** The narrow state dependency the cursor write needs. */
interface CursorDeps {
  readonly state: StateManager;
}

/** The single JSON document the state-write subcommands emit — the next loop step. */
export interface TransitionEnvelope {
  readonly run_id: string;
  readonly task_id: string;
  /** Keep going at `step.stage`, or stop with `step.outcome` (done/dropped). */
  readonly step: TaskStep;
}

/**
 * After a transition, persist the in-flight CURSOR for a non-terminal step so the
 * persisted task status tracks the resume point (the loop does this implicitly at the
 * top of each iteration; the single-step CLI must do it explicitly). A terminal step
 * (`done`/`dropped`) already wrote its own status — nothing to mark.
 */
export async function persistStepCursor(
  deps: CursorDeps,
  runId: string,
  taskId: string,
  step: TaskStep,
): Promise<void> {
  if (!step.done) {
    await markInFlight(deps, runId, taskId, step.stage);
  }
}

/** Read + parse a JSON input file (the orchestrator's collected agent output). */
export async function readJsonInput<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return parseJson<T>(raw, path);
}
