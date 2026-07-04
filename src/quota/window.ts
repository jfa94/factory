/**
 * WS4 — Pure two-window position + threshold math (Decision 24).
 *
 * Ported from `bin/pipeline-lib.sh`'s `compute_window_hour` /
 * `compute_window_day` / `compute_hourly_threshold` / `compute_daily_threshold`,
 * but as PURE functions: no `Date.now`, no I/O. The caller passes `nowEpoch` so
 * the math is fully deterministic and the gate-math tests can pin exact vectors.
 *
 * Window model (session-anchored, NOT UTC-clock):
 *   - 5h window: spans `resets_at - 18000s` (= 5h) up to `resets_at`. The current
 *     window-HOUR is `floor((now - window_start) / 3600) + 1`, clamped to [1,5].
 *   - 7d window: spans `resets_at - 604800s` (= 7d) up to `resets_at`. The current
 *     window-DAY is `floor((now - window_start) / 86400) + 1`, clamped to [1,7].
 *
 * Thresholds index the FROZEN `QuotaSchema` curves (defaults `[20,40,60,80,90]`
 * for the 5h curve, `[14,29,43,57,71,86,95]` for the 7d curve) by the window
 * position minus one, with the index clamped to the array bounds — the value is
 * the UTILIZATION cap (%) for that window position.
 */

import {at} from '../shared/index.js'

/** Seconds in the 5h window (5 * 3600). */
export const FIVE_HOUR_WINDOW_SECONDS = 18000
/** Seconds in the 7d window (7 * 86400). */
export const SEVEN_DAY_WINDOW_SECONDS = 604800

const SECONDS_PER_HOUR = 3600
const SECONDS_PER_DAY = 86400

const MIN_HOUR = 1
const MAX_HOUR = 5
const MIN_DAY = 1
const MAX_DAY = 7

function clamp(value: number, lo: number, hi: number): number {
    if (value < lo) {
        return lo
    }
    if (value > hi) {
        return hi
    }
    return value
}

/**
 * The current window-HOUR (1..5) for a 5h window resetting at `resetsAtEpoch`.
 * `floor((now - (resets - 18000)) / 3600) + 1`, clamped to [1,5]. Mirrors the
 * bash `compute_window_hour`. Pure: no clock read.
 */
export function computeWindowHour(resetsAtEpoch: number, nowEpoch: number): number {
    const windowStart = resetsAtEpoch - FIVE_HOUR_WINDOW_SECONDS
    const elapsed = nowEpoch - windowStart
    const hour = Math.floor(elapsed / SECONDS_PER_HOUR) + 1
    return clamp(hour, MIN_HOUR, MAX_HOUR)
}

/**
 * The current window-DAY (1..7) for a 7d window resetting at `resetsAtEpoch`.
 * `floor((now - (resets - 604800)) / 86400) + 1`, clamped to [1,7]. Mirrors the
 * bash `compute_window_day`. Pure: no clock read.
 */
export function computeWindowDay(resetsAtEpoch: number, nowEpoch: number): number {
    const windowStart = resetsAtEpoch - SEVEN_DAY_WINDOW_SECONDS
    const elapsed = nowEpoch - windowStart
    const day = Math.floor(elapsed / SECONDS_PER_DAY) + 1
    return clamp(day, MIN_DAY, MAX_DAY)
}

/**
 * The 5h-curve utilization cap (%) for window-`hour` (1..5). Indexes
 * `hourlyThresholds[hour - 1]`, with the index clamped to the array bounds (so a
 * clamped hour outside [1,5] still resolves to the nearest curve point). Mirrors
 * `compute_hourly_threshold`.
 */
export function hourlyThresholdFor(hour: number, hourlyThresholds: readonly number[]): number {
    return curveValue(hour, hourlyThresholds)
}

/**
 * The 7d-curve utilization cap (%) for window-`day` (1..7). Indexes
 * `dailyThresholds[day - 1]`, with the index clamped to the array bounds. Mirrors
 * `compute_daily_threshold`.
 */
export function dailyThresholdFor(day: number, dailyThresholds: readonly number[]): number {
    return curveValue(day, dailyThresholds)
}

/**
 * Index a curve array by `position - 1`, clamping the index to `[0, len-1]`. The
 * frozen `QuotaSchema` guarantees the arrays are non-empty (length 5 / 7), but we
 * still loud-fail on an empty array rather than return `undefined` — a missing
 * curve is a config defect, never a silent open gate.
 */
function curveValue(position: number, curve: readonly number[]): number {
    if (curve.length === 0) {
        throw new RangeError('quota curve is empty — cannot resolve a threshold (config defect)')
    }
    const idx = clamp(position - 1, 0, curve.length - 1)
    return at(curve, idx)
}
