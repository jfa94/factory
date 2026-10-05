/**
 * Derive-don't-store gate verdicts (Δ V / Decision 26). A verdict is NEVER read
 * back from persisted state: it is recomputed from the gate evidence observed now,
 * and the phantom brand means only this module can mint a {@link GateVerdict}.
 */
import type {EvidenceGate} from './gate-id.js'

/** Ground-truth evidence a gate produced on this check. */
export interface GateEvidence {
    /** Stable label from the closed {@link EvidenceGate} domain. */
    gate: EvidenceGate
    /** The raw outcome of running the gate NOW — never a remembered boolean. */
    observed: boolean
    /** Optional detail for the audit trail (e.g. "mutation score 82% ≥ 80%"). */
    detail?: string
}

/** Type-only nominal brand; external code cannot assemble a verdict by hand. */
declare const DERIVED_BRAND: unique symbol

/** A computed verdict that always carries its derivation. */
export interface GateVerdict {
    /** True iff the gate passes, computed from the supplied evidence. */
    readonly passed: boolean
    /** The gate this verdict is for. */
    readonly gate: string
    /** Observable brand: marks this value as freshly derived, not reconstructed from JSON. */
    readonly __derived: true
    /** Phantom nominal brand (type-only; see {@link DERIVED_BRAND}). */
    readonly [DERIVED_BRAND]: true
    /** The evidence the verdict was derived from (audit trail). */
    readonly from: readonly GateEvidence[]
}

/**
 * Derive the conjunctive verdict over many gates: passes IFF every gate passes
 * AND at least one gate was supplied. An empty evidence set FAILS (nothing ran is
 * never a pass).
 */
export function deriveAllGatesVerdict(evidence: readonly GateEvidence[]): GateVerdict {
    const passed = evidence.length > 0 && evidence.every((e) => e.observed)
    return mkVerdict(passed, 'all', [...evidence])
}

/** The SOLE mint: the one cast that attaches the type-only brand. */
function mkVerdict(passed: boolean, gate: string, from: readonly GateEvidence[]): GateVerdict {
    return {passed, gate, __derived: true, from} as GateVerdict
}
