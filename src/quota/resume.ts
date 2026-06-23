/**
 * WS4 — The resumable-entrypoint SEAM for human-invoked `factory run resume`
 * (Decision 24, Δ F). v1 = HUMAN relaunch only; this file deliberately contains
 * NO scheduler / scheduled-wake (v2 — a v2 wake would fire the SAME
 * {@link planResume}). The driver (WS10) supplies the persisted {@link RunState}
 * and applies the returned patch via StateManager.
 *
 * {@link planResume} pulls a FRESH {@link UsageReading} (the relaunched session has
 * a live statusline cache) rather than trusting the persisted `resets_at_epoch`
 * alone — the bash source's post-reset stale guards mean the persisted horizon is
 * not a sufficient oracle for "the window has actually reset". If usage is now
 * observable AND under curve, resume clears the checkpoint; otherwise it returns
 * the still-blocking decision so the human is told the window has not recovered.
 *
 * A resume NEVER touches committed task state: it only returns the run-level
 * status/quota patch (Decision 24 — suspended means "no work dropped, nothing
 * failed quality", so done/dropped tasks stay exactly as persisted).
 */
import type { RunState } from "../types/index.js";
import type { Config } from "../config/schema.js";
import type { UsageReading } from "./usage-source.js";
import { evaluate as evaluatePacer, type QuotaDecision } from "./pacer.js";
import { clearCheckpoint, type ClearCheckpointPatch } from "./checkpoint.js";

/**
 * The plan a resume produces:
 *   - `resume`        — the binding window has recovered (usage observable + under
 *                       curve); `clear` is the checkpoint-clearing patch the driver
 *                       applies to return the run to `running`.
 *   - `still-blocked` — usage is still over curve (or unobservable); `decision`
 *                       carries the fresh pacer decision so the caller can report
 *                       why resume did not proceed.
 *   - `not-resumable` — the persisted run is not in a resumable (paused|suspended)
 *                       state, so there is nothing to resume.
 */
export type ResumePlan =
  | { kind: "resume"; clear: ClearCheckpointPatch }
  | { kind: "still-blocked"; decision: QuotaDecision }
  | { kind: "not-resumable"; status: RunState["status"] };

/**
 * Decide whether a persisted run can resume now. Pure given the run, a FRESH
 * usage reading, the config curves, and `nowEpoch`. Only `paused`/`suspended`
 * runs are resumable; for those, a fresh `proceed` decision clears the checkpoint
 * and the run returns to `running`, while any non-proceed decision keeps it
 * blocked (fail-closed: an unobservable reading is `still-blocked`, never resumed).
 */
export function planResume(
  run: RunState,
  reading: UsageReading,
  config: Config,
  nowEpoch: number,
): ResumePlan {
  if (run.status !== "paused" && run.status !== "suspended") {
    return { kind: "not-resumable", status: run.status };
  }

  // --ignore-quota: skip the live pacer check and force a clear unconditionally.
  if (run.ignore_quota) {
    return { kind: "resume", clear: clearCheckpoint() };
  }

  const decision = evaluatePacer(reading, config, nowEpoch);
  if (decision.kind === "proceed") {
    return { kind: "resume", clear: clearCheckpoint() };
  }
  return { kind: "still-blocked", decision };
}
