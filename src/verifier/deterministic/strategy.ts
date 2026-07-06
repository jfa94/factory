/**
 * WS6 — the per-gate STRATEGY seam (D26 deterministic layer).
 *
 * ONE GateRunner orchestrates a set of strategies, one per gate. Each strategy is
 * a pure-ish implementer: it runs its machine-check (via an injectable tool wrapper
 * over shared/exec.ts) and reports a {@link GateOutcome}. It does NOT compute a
 * verdict — the runner derives the verdict from the collected GateEvidence via
 * src/core/state/derive.ts (derive-don't-store, Δ V).
 *
 * A strategy NEVER returns a pre-existing pass: the only way to a `pass` outcome is
 * to actually run the check and observe success. A "not applicable" situation is a
 * distinct {@link GateSkip} outcome — so "nothing ran" is structurally never
 * confused with "the gate passed".
 */
import type {GateEvidence} from '../../types/index.js'
import type {Config} from '../../config/schema.js'
import type {ExemptReader} from './tdd-exempt.js'
import type {GateContract} from './gate-contract.js'
import type {CoverageStore} from './coverage-store.js'
import {GATE_IDS, type GateId} from './gate-id.js'

// Re-exported from the leaf gate-id.ts so existing importers of strategy.ts are
// unaffected.
export {GATE_IDS, type GateId}

/**
 * A strategy ran and produced ground-truth evidence. `observed` is the raw
 * machine-checkable pass signal (true iff the check passed NOW). The runner feeds
 * this evidence into deriveGateVerdict / deriveAllGatesVerdict — it is never a
 * stored boolean.
 */
export interface GateRan {
    readonly kind: 'ran'
    readonly evidence: GateEvidence
}

/**
 * The gate is NOT APPLICABLE on this task (no package.json, no script configured,
 * no mutable changes, …). A skip is NEITHER a pass NOR a fail: it is excluded from
 * the conjunction so it cannot default-open the merge gate, but it is recorded LOUDLY
 * with a reason for the audit trail.
 */
export interface GateSkip {
    readonly kind: 'skip'
    readonly gate: GateId
    readonly reason: string
}

/** What a strategy returns: it either RAN (with evidence) or SKIPPED (with reason). */
export type GateOutcome = GateRan | GateSkip

/** Convenience constructor: a strategy that ran, with its observed pass signal. */
export function ran(gate: GateId, observed: boolean, detail?: string): GateRan {
    const evidence: GateEvidence = detail === undefined ? {gate, observed} : {gate, observed, detail}
    return {kind: 'ran', evidence}
}

/** Convenience constructor: a strategy that skipped (not applicable). */
export function skip(gate: GateId, reason: string): GateSkip {
    return {kind: 'skip', gate, reason}
}

/**
 * Context a strategy needs to run: the worktree to check, the base ref to diff
 * against, run/task ids for audit, the resolved config (the ONE config that drives
 * every gate threshold), and the injected tools (so units run without real CLIs).
 *
 * `T` is the injected tool-bag type — see {@link GateTools} in tools.ts. Kept
 * generic so a strategy declares exactly the tools it touches without the runner
 * pinning a concrete shape here (avoids a circular module dependency).
 */
export interface StrategyContext<TTools> {
    readonly runId: string
    readonly taskId: string
    /** Absolute path of the worktree the gate runs against. */
    readonly worktree: string
    /** Base ref for diff-scoping (e.g. "staging"); strategies resolve origin/<base>. */
    readonly baseRef: string
    /** The resolved config — the single source of every gate threshold. */
    readonly config: Config
    /** Injected tool wrappers (real or fake). */
    readonly tools: TTools
    /**
     * tdd_exempt resolver (tasks.json / package.json, never state.json). Required by
     * the tdd strategy; other strategies ignore it. Optional so non-TDD callers need
     * not supply it.
     */
    readonly exemptReader?: ExemptReader | undefined
    /**
     * The repo's gate contract (S7, Decision 46). Command gates (test/type/build/
     * lint) execute a contracted `command` override instead of their built-in tool.
     * The GateRunner always supplies it (it throws when `.factory/gates.json` is
     * absent); optional only for direct-strategy unit tests.
     */
    readonly contract?: GateContract | undefined
    /**
     * Per-tree-SHA coverage summary store (S8). A perf cache only: absent means
     * the coverage strategy measures uncached — never a correctness fallback.
     */
    readonly coverageStore?: CoverageStore | undefined
}

/**
 * A deterministic gate strategy. Every strategy + every fake implements this.
 * `run` returns a {@link GateOutcome} and never throws for an ordinary gate
 * failure (that is `observed:false`); it MAY throw only on a structural / loud
 * error the runner must surface (e.g. truncated tool output).
 */
export interface GateStrategy<TTools> {
    readonly id: GateId
    run(ctx: StrategyContext<TTools>): Promise<GateOutcome>
}
