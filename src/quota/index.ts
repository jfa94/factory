/**
 * WS4 — Public barrel for `src/quota` (Decision 24, Δ E/F). WS10 imports the whole
 * quota seam from this one path.
 *
 * The architecture, top to bottom:
 *   - usage-source : the injectable {@link UsageSignal} + fail-closed reader.
 *   - window       : pure two-window position + threshold math.
 *   - pacer        : the pure two-window decision → {@link QuotaDecision}.
 */

// Usage signal seam + reader
export {
    StatuslineUsageSignal,
    fakeUsageSignal,
    readingFromCache,
    usageCachePath,
    STALE_CEILING_SECONDS,
    STALE_WARN_SECONDS,
} from './usage-source.js'
export type {UsageSignal, UsageReading, WindowUsage, UnavailableReason, StatuslineUsageOptions} from './usage-source.js'

// Window math (position/threshold functions are quota-internal — pacer consumes them directly)
export {FIVE_HOUR_WINDOW_SECONDS, SEVEN_DAY_WINDOW_SECONDS} from './window.js'

// Pacer
export {evaluate} from './pacer.js'
export type {QuotaDecision} from './pacer.js'
