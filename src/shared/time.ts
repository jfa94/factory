/**
 * ISO-8601 time helpers — frozen seam (WS4's quota windows consume these).
 *
 * Ports the portable parse from `bin/pipeline-lib.sh:parse_iso8601_to_epoch`,
 * but in JS we have a real Date parser so we don't need the gdate/date -j shell
 * fallbacks — `Date.parse` handles ISO-8601 across platforms uniformly.
 *
 * Convention: epoch values are SECONDS (matching the bash code and the quota
 * window math), not milliseconds. `nowIso()` emits a `Z`-suffixed UTC string.
 */

/** Current time as an ISO-8601 UTC string, e.g. `2026-06-04T12:34:56.789Z`. */
export function nowIso(): string {
    return new Date().toISOString()
}

/** Current time as epoch SECONDS (integer). */
export function nowEpoch(): number {
    return Math.floor(Date.now() / 1000)
}

/**
 * Parse an ISO-8601 timestamp to epoch SECONDS.
 * Throws on an unparseable string (loud-fail, matching the bash `return 1`
 * contract that callers checked).
 */
export function parseIso8601ToEpoch(iso: string): number {
    const ms = Date.parse(iso)
    if (Number.isNaN(ms)) {
        throw new RangeError(`parseIso8601ToEpoch: unparseable ISO-8601 timestamp: ${iso}`)
    }
    return Math.floor(ms / 1000)
}

/** Convert epoch SECONDS to an ISO-8601 UTC string. */
export function epochToIso(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toISOString()
}
