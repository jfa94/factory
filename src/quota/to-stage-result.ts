/**
 * WS4 — The single adapter from a {@link QuotaDecision} to the FROZEN WS2
 * {@link StageResult}. This is the ONLY place quota touches the StageResult union.
 *
 * It is structurally impossible for quota to emit `finalize-terminal` (`partial`)
 * or `task-terminal` (`dropped`): this module imports ONLY {@link gracefulStop}
 * and can construct nothing else (Δ E). `proceed` maps to `null` (the caller
 * continues normally — there is no "advance" for quota to choose; that is the
 * driver's job). `unavailable-halt` reuses the `7d` suspend-shaped clean exit
 * because usage cannot be observed and the run must persist + resume (matching
 * the bash `unavailable → end_gracefully` production path); the frozen StageResult
 * exposes only `5h`/`7d` scopes, so a distinct "unavailable" scope would be a seam
 * change (out of bounds for WS4).
 */
import { gracefulStop } from "../types/index.js";
import type { GracefulStopResult } from "../types/index.js";
import { assertNever } from "../types/index.js";
import type { QuotaDecision } from "./pacer.js";

/**
 * Map a quota decision onto its StageResult. Returns `null` for `proceed` (no
 * stage result — keep going); otherwise a {@link GracefulStopResult}. The codomain
 * is `GracefulStopResult | null` — it CANNOT include partial or drop.
 */
export function decisionToStageResult(decision: QuotaDecision): GracefulStopResult | null {
  switch (decision.kind) {
    case "proceed":
      return null;
    case "pause-5h":
      return gracefulStop("5h", decision.reason, decision.resetsAtEpoch);
    case "suspend-7d":
      return gracefulStop("7d", decision.reason, decision.resetsAtEpoch);
    case "unavailable-halt":
      // Usage unobservable → clean, resumable suspend (7d-shaped). No reset
      // horizon is known, so resets_at_epoch is omitted.
      return gracefulStop("7d", decision.reason);
    default:
      return assertNever(decision);
  }
}
