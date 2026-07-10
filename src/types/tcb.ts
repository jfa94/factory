/**
 * TCB (Trusted Computing Base) STRUCTURAL TYPES — definition home.
 *
 * These describe the shape of the hardcoded write-deny denylist; the LOGIC that
 * compiles and matches it (`buildTcbRules`, `isTcbProtected`, `TCB_DENY`,
 * `canonicalizePath`) lives in `src/hooks/tcb.ts`, which imports these types DOWN
 * from here and re-exports them for back-compat. The types live in `src/types`
 * (a foundational leaf, imports nothing) so the public type facade no longer has
 * to reach UP into the `hooks` enforcement layer — the dependency now points the
 * correct way (hooks → types). A pure leaf: no imports, so it can never cycle.
 */

/**
 * CLOSED category enum for a protected path. A new category is a DESIGN change
 * (a deliberate compile-break across the adversarial suite), not a config tweak
 * — mirrors the WS1/WS2 closed-enum discipline.
 */
export type TcbCategory =
    | 'ci-workflows'
    | 'gate-config'
    | 'gate-contract'
    | 'scaffold-lock'
    | 'hooks'
    | 'data-runs'
    | 'data-specs'
    | 'data-config'
    | 'docs-factory'
    | 'e2e-suite'

/** One compiled denylist rule. `test(absPath)` decides membership. */
export interface TcbRule {
    /** Which protection class this rule enforces. */
    readonly category: TcbCategory
    /** Human-readable description of what the rule protects (for deny reasons). */
    readonly describe: string
    /** True iff the (already canonicalized, absolute) path is protected by this rule. */
    readonly test: (absPath: string) => boolean
}

/** A positive match: the rule that fired + the canonical path it matched. */
export interface TcbMatch {
    /** The rule that matched. */
    readonly rule: TcbRule
    /** The canonical absolute path that matched (post normalize/realpath). */
    readonly canonical: string
}

/**
 * Context for a TCB check. ALL fields are PATH-RESOLUTION inputs only — none is
 * a policy input. There is intentionally no `config` field: the denylist cannot
 * be widened/narrowed by config (Δ W). `dataDir` is supplied so the out-of-repo
 * run/spec stores can be protected at their absolute location, but it sets only
 * WHERE the data dir is, never WHETHER it is protected.
 */
export interface TcbContext {
    /** The repo root (target repo) absolute path. Used for `.github/`, `hooks/`, `e2e/`. */
    readonly repoRoot?: string
    /** The plugin data dir absolute path (out-of-repo `runs/`, `specs/`). */
    readonly dataDir?: string | undefined
}
