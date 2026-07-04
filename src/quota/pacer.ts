/**
 * WS4 — The two-window quota pacer (Decision 24, Δ E/F). PURE: no state, no exit,
 * no sleep. Given a {@link UsageReading}, the config curves, and `nowEpoch`, it
 * emits a {@link QuotaDecision}.
 *
 * The decision space is deliberately small and quota-only — it can describe
 * proceed, a 5h PAUSE-in-place, a 7d SUSPEND (clean exit + resumable), or a
 * fail-closed HALT when usage cannot be observed. Crucially it can NEVER describe
 * a quality `partial` or a `failed` task (Δ E): the pacer has no vocabulary for
 * those outcomes, so "quota never emits partial/fail" is true by construction.
 *
 * Window semantics: utilization is compared with strict `>` against the curve cap
 * for the CURRENT window position (matching the bash `$a > $b` over_threshold
 * test). At-or-below the cap proceeds; strictly above breaches.
 *
 * Binding-window rule: when BOTH windows breach, the 7d window dominates and the
 * decision is `suspend-7d`. A 5h pause self-heals in-session by waiting out the
 * rising curve, but the 7d recovery horizon is unholdable mid-run (Decision 24),
 * so the more-constrained window wins.
 */
import type {Config} from '../config/schema.js'
import type {UsageReading} from './usage-source.js'
import {computeWindowHour, computeWindowDay, hourlyThresholdFor, dailyThresholdFor} from './window.js'

/**
 * A quota pacing decision. Closed discriminated union on `kind`:
 *   - `proceed`           — both windows at-or-below curve; continue normally.
 *   - `pause-5h`          — 5h window over curve; PAUSE in place (RunStatus paused),
 *                           self-heals as the curve rises. Carries the resume horizon.
 *   - `suspend-7d`        — 7d window over curve (dominant); SUSPEND (persist + clean
 *                           exit, RunStatus suspended), resume via `factory run resume`.
 *   - `unavailable-halt`  — usage could not be observed (fail-closed sentinel); HALT
 *                           cleanly rather than proceed blind.
 */
export type QuotaDecision =
    | {kind: 'proceed'}
    | {kind: 'pause-5h'; resetsAtEpoch: number; reason: string}
    | {kind: 'suspend-7d'; resetsAtEpoch: number; reason: string}
    | {kind: 'unavailable-halt'; reason: string}

/**
 * Evaluate the two-window pacer. Pure; the caller supplies `nowEpoch`. Maps an
 * `unavailable` reading to `unavailable-halt` (fail-closed — like the bash
 * sentinel routing to end_gracefully), never to `proceed`.
 */
export function evaluate(reading: UsageReading, config: Config, nowEpoch: number): QuotaDecision {
    if (reading.kind === 'unavailable') {
        return {kind: 'unavailable-halt', reason: `usage unavailable: ${reading.reason}`}
    }

    const {hourlyThresholds, dailyThresholds} = config.quota

    const windowHour = computeWindowHour(reading.fiveHour.resetsAtEpoch, nowEpoch)
    const hourlyCap = hourlyThresholdFor(windowHour, hourlyThresholds)
    const fiveOver = reading.fiveHour.utilizationPct > hourlyCap

    const windowDay = computeWindowDay(reading.sevenDay.resetsAtEpoch, nowEpoch)
    const dailyCap = dailyThresholdFor(windowDay, dailyThresholds)
    const sevenOver = reading.sevenDay.utilizationPct > dailyCap

    // Binding-window rule: 7d dominates 5h (unholdable horizon — Decision 24).
    if (sevenOver) {
        return {
            kind: 'suspend-7d',
            resetsAtEpoch: reading.sevenDay.resetsAtEpoch,
            reason:
                `7d quota over curve: ${reading.sevenDay.utilizationPct}% used > ` +
                `${dailyCap}% cap at window-day ${windowDay}`,
        }
    }

    if (fiveOver) {
        return {
            kind: 'pause-5h',
            resetsAtEpoch: reading.fiveHour.resetsAtEpoch,
            reason:
                `5h quota over curve: ${reading.fiveHour.utilizationPct}% used > ` +
                `${hourlyCap}% cap at window-hour ${windowHour}`,
        }
    }

    return {kind: 'proceed'}
}
