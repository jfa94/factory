/**
 * WS2 — the injectable, FAKEABLE handler contract.
 *
 * The engine depends ONLY on {@link StageHandlers} (an interface), never on a
 * concrete implementation. Real handlers (WS3 git, WS6/7 verifier, WS8 producer)
 * do the shelling-out; the engine stays a PURE control-flow shell. Tests inject
 * fakes that return canned {@link StageResult}s — that is the whole testability
 * argument.
 *
 * Every handler receives a READ-ONLY {@link StageContext} (the WS1 state the engine
 * passes in) and returns a `Promise<StageResult>`. Handlers do not write state and
 * do not decide transitions — they report a decision; the driver acts on it.
 */
import type { RunState, TaskState } from "../state/index.js";
import type { StageResult } from "./result.js";

/**
 * The read-only inputs a handler needs. The engine passes WS1 state in; handlers
 * never mutate it (the driver owns the StateManager write). `task` is absent for
 * the run-level `finalize` handler and present for every per-task stage.
 */
export interface StageContext {
  /** The whole run (spec pointer + task map + status). Read-only to handlers. */
  readonly run: RunState;
  /** The task this stage acts on; absent for the run-level `finalize` stage. */
  readonly task?: TaskState;
  /**
   * The current attempt number for a bounded `wait-retry`, when the driver is
   * re-invoking the same stage. Absent on a first invocation (treated as 1).
   */
  readonly attempt?: number;
}

/**
 * One async method per stage. The engine selects the method by stage name and
 * returns its result after a single exhaustiveness check. This is the seam tests
 * fake.
 */
export interface StageHandlers {
  preflight(ctx: StageContext): Promise<StageResult>;
  tests(ctx: StageContext): Promise<StageResult>;
  exec(ctx: StageContext): Promise<StageResult>;
  verify(ctx: StageContext): Promise<StageResult>;
  ship(ctx: StageContext): Promise<StageResult>;
  /** Run-level; ALWAYS returns a `finalize-terminal` (or throws). Never spins. */
  finalize(ctx: StageContext): Promise<StageResult>;
}
