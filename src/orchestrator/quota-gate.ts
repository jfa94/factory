/**
 * The run-level quota gate, shared by both orchestrators (next/drive).
 * Reads the usage signal, evaluates the two-window pacer, and on a breach
 * persists the matching checkpoint + status and returns a structured
 * {@link QuotaStop}; on proceed returns null. Unobservable fails closed
 * (`suspended`, scope "unavailable", no horizon).
 *
 * On a proceed (null return) the gate never writes state; clearing a stale
 * paused/suspended checkpoint on recovery is the CALLER's job (see nextAction in
 * orchestrator.ts and nextTask in next.ts).
 */
import { evaluateQuota, buildCheckpoint, assertNever } from "./deps.js";
import type { Config, RunState, StateManager, UsageSignal } from "./deps.js";
import { createLogger } from "../shared/index.js";

const log = createLogger("quota-gate");

/** The narrow deps the gate needs (a subset of OrchestratorDeps). */
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
  mode: RunState["mode"] = "session",
  ignoreQuota = false,
): Promise<QuotaStop | null> {
  // Workflow mode (Decision 24) and --ignore-quota both skip pacing entirely.
  // Neither reads the usage signal nor writes state.
  if (mode === "workflow" || ignoreQuota) return null;
  const reading = await deps.usage.read();
  const decision = evaluateQuota(reading, deps.config, deps.now());
  if (decision.kind === "proceed") {
    return null; // proceed: the gate never writes state (recovery is the caller's job)
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
    default:
      return assertNever(decision);
  }
}

/**
 * The shared spread for a quota-pause return: scope + reason + optional resets_at_epoch.
 * Both orchestrators (nextAction, nextTask) spread this into their pause envelope.
 */
export function quotaStopFields(stop: QuotaStop): {
  scope: QuotaStop["scope"];
  reason: string;
  resets_at_epoch?: number;
} {
  return {
    scope: stop.scope,
    reason: stop.reason,
    ...(stop.resets_at_epoch !== undefined ? { resets_at_epoch: stop.resets_at_epoch } : {}),
  };
}
