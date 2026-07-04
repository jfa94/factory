/**
 * WS7 — cross-vendor slot resolution + LOUD-when-absent (Δ U).
 *
 * The judgment panel and the verify-then-fix finding-verifier are STRONGER when a
 * SECOND vendor (Codex) is available, because an independent vendor is a genuinely
 * independent adversary. But a second vendor is not always present. Δ U: its
 * absence must be recorded LOUDLY — surfaced for audit and forced onto the caller
 * — and NEVER papered over by silently substituting a same-vendor (Claude)
 * reviewer into the cross-vendor slot pretending to be cross-vendor.
 *
 * {@link resolveCrossVendor} returns a DISCRIMINATED result. The `absent` variant
 * carries a `reason`; there is no third "defaulted" state and no boolean a caller
 * could ignore. The probe is injected ({@link VendorProbe}) so units never invoke
 * the real Codex CLI; a probe that throws/ENOENTs is treated as absent-with-reason
 * (a missing binary is exactly "the vendor is not available"), never a crash.
 */

/**
 * Probes whether a second vendor executor is available. Wraps the real
 * availability check (e.g. `codex --version` via the frozen exec seam) behind an
 * interface so units inject a fake. `available()` resolves true/false; it MAY
 * reject (e.g. spawn ENOENT) — {@link resolveCrossVendor} catches that and treats
 * it as absent, so a missing binary is a clean "absent", not an exception.
 */
export interface VendorProbe {
    /** The vendor this probe checks, e.g. "codex". For the audit record. */
    readonly vendor: string
    /** True iff the vendor executor is usable right now. May reject. */
    available(): Promise<boolean>
}

/** The resolved cross-vendor slot when a second vendor IS present. */
export interface CrossVendorSlot {
    /** The vendor id (e.g. "codex"). */
    readonly vendor: string
    /** The model the cross-vendor executor runs (from config.codex.model). */
    readonly model: string
}

/**
 * Result of resolving the cross-vendor slot. Closed discriminated union on
 * `status`:
 *   - `present` — a real second vendor is available; `slot` describes it.
 *   - `absent`  — no second vendor; `reason` says why. The caller MUST handle
 *     this branch (Δ U) — it cannot be mistaken for `present`.
 */
export type CrossVendorResolution =
    | {readonly status: 'present'; readonly slot: CrossVendorSlot}
    | {readonly status: 'absent'; readonly reason: string}

/**
 * Resolve the cross-vendor slot (Δ U). `present` ONLY when the probe reports the
 * vendor available AND a model is configured for it; otherwise an explicit
 * `absent` with a reason. A probe that rejects is treated as absent (the error
 * message becomes the reason) — a missing/broken second-vendor binary is "absent",
 * not a pipeline crash. No path substitutes a same-vendor reviewer.
 *
 * @param codexModel the configured cross-vendor model (config.codex.model);
 *   `undefined` ⇒ no model configured ⇒ absent, even if the probe says available
 *   (we will not invent a model).
 */
export async function resolveCrossVendor(
    codexModel: string | undefined,
    probe: VendorProbe
): Promise<CrossVendorResolution> {
    let available: boolean
    try {
        available = await probe.available()
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return {
            status: 'absent',
            reason: `cross-vendor probe '${probe.vendor}' failed: ${detail}`,
        }
    }

    if (!available) {
        return {
            status: 'absent',
            reason: `cross-vendor executor '${probe.vendor}' is not available`,
        }
    }

    if (codexModel === undefined || codexModel.trim().length === 0) {
        return {
            status: 'absent',
            reason: `cross-vendor executor '${probe.vendor}' is available but no model is configured (codex.model)`,
        }
    }

    return {status: 'present', slot: {vendor: probe.vendor, model: codexModel}}
}
