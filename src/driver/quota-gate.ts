/**
 * The run-level quota gate, shared by the two pumps (next/drive) and driveRun.
 * Reads the usage signal, evaluates the two-window pacer, and on a breach
 * persists the matching checkpoint + status and returns a structured
 * {@link QuotaStop}; on proceed returns null. Unobservable fails closed
 * (`suspended`, scope "unavailable", no horizon).
 *
 * Extracted verbatim from loop.ts (same behavior; the return type is enriched
 * so envelope-emitting callers can surface scope/reason/horizon).
 *
 * On a proceed (null return) the gate never writes state; clearing a stale
 * paused/suspended checkpoint on recovery is the CALLER's job (see driveRun in
 * loop.ts; the pumps later).
 */
import { evaluateQuota, decisionToStageResult, buildCheckpoint, assertNever } from "./deps.js";
import type { Config, RunState, StateManager, UsageSignal } from "./deps.js";
import { createLogger } from "../shared/index.js";

const log = createLogger("quota-gate");

/** The narrow deps the gate needs (a subset of DriveDeps/PumpDeps). */
export interface QuotaGateDeps {
  readonly state: StateManager;
  readonly usage: UsageSignal;
  readonly config: Config;
  /** Epoch SECONDS. */
  readonly now: () => number;
}

/** A persisted quota stop: which window, why, when it resets, the stopped run. */
export interface QuotaStop {
  readonly scope: "5h" | "7d" | "unavailable";
  readonly reason: string;
  readonly resets_at_epoch?: number;
  readonly run: RunState;
}

export async function applyQuotaGate(
  deps: QuotaGateDeps,
  runId: string,
): Promise<QuotaStop | null> {
  const reading = await deps.usage.read();
  const decision = evaluateQuota(reading, deps.config, deps.now());
  if (decisionToStageResult(decision) === null) {
    return null; // proceed
  }
  switch (decision.kind) {
    case "pause-5h":
    case "suspend-7d": {
      const patch = buildCheckpoint(decision);
      log.warn(`run '${runId}' ${decision.kind}: ${decision.reason}`);
      const run = await deps.state.update(runId, (s) => ({
        ...s,
        status: patch.status,
        quota: patch.quota,
      }));
      return {
        scope: decision.kind === "pause-5h" ? "5h" : "7d",
        reason: decision.reason,
        resets_at_epoch: decision.resetsAtEpoch,
        run,
      };
    }
    case "unavailable-halt": {
      log.warn(`run '${runId}' quota unavailable — suspending: ${decision.reason}`);
      const run = await deps.state.update(runId, (s) => ({
        ...s,
        status: "suspended",
        quota: undefined,
      }));
      return { scope: "unavailable", reason: decision.reason, run };
    }
    case "proceed":
      return null; // unreachable (decisionToStageResult==null already handled it)
    default:
      return assertNever(decision);
  }
}
