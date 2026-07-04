/**
 * S8 — EXECUTABLE coverage gate (base-vs-head, measure-on-miss).
 *
 * Replaces the dead before/after file reader: the strategy MEASURES coverage by
 * running the contracted test command with vitest's json-summary reporter, once
 * per tree SHA:
 *   - HEAD is measured in the task worktree;
 *   - BASE is measured in an ephemeral detached worktree at the base commit
 *     (reusing head's node_modules) — but only on a store miss: summaries are
 *     persisted per tree SHA in the run's {@link CoverageStore}, and a post-squash
 *     staging tree equals the merged task's head tree, so later tasks are served
 *     from the store.
 * Per-metric delta rounded to 2dp; FAILS if any of {lines, branches, functions,
 * statements} decreased by MORE than `quality.coverageRegressionTolerancePct`
 * (default 0.5). Every non-measured answer (command failed, summary missing or
 * invalid, unresolvable base) is fail-closed and names which side broke.
 *
 * The ONLY skip is `no-gate-contract` (legacy pre-contract worktree — the runner
 * already warns). An UNCONTRACTED coverage gate never reaches this strategy: the
 * runner skips it with the contract's committed reason.
 */
import {contractCommand, type GateContract} from '../gate-contract.js'
import type {GateOutcome, GateStrategy, StrategyContext} from '../strategy.js'
import {ran, skip} from '../strategy.js'
import type {CoverageCommand, CoverageMeasurement, CoverageSummary, GateTools} from '../tools.js'
import {excerpt} from './proc-strategy.js'
import {resolveBase} from './tdd.js'

const METRICS = ['lines', 'branches', 'functions', 'statements'] as const
type Metric = (typeof METRICS)[number]

/** Round to 2 decimal places, mirroring jq `(x*100|round)/100`. */
export function round2(x: number): number {
    return Math.round(x * 100) / 100
}

/** Per-metric delta (after - before), each rounded to 2dp. */
export function coverageDelta(before: CoverageSummary, after: CoverageSummary): Record<Metric, number> {
    return {
        lines: round2(after.lines - before.lines),
        branches: round2(after.branches - before.branches),
        functions: round2(after.functions - before.functions),
        statements: round2(after.statements - before.statements),
    }
}

/**
 * Metrics that decreased beyond tolerance. A metric fails when its delta is
 * STRICTLY LESS than `-tolerance` (bin/pipeline-coverage-gate:90-92: `$d.x < (-1*$t)`).
 */
export function regressions(delta: Record<Metric, number>, tolerance: number): Metric[] {
    const threshold = -1 * tolerance
    return METRICS.filter((m) => delta[m] < threshold)
}

/** The vitest flags that turn the contracted test run into a summary-writing one. */
export const COVERAGE_FLAGS = [
    '--coverage.enabled=true',
    '--coverage.reporter=json-summary',
    '--coverage.reportsDirectory=coverage',
] as const

/** How the coverage command was (or was not) derived from the contract. */
export type CoverageCommandResolution =
    | {readonly ok: true; readonly cmd: CoverageCommand}
    | {readonly ok: false; readonly reason: string}

/**
 * Derive the coverage measurement command from the gate contract:
 *   1. a `gates.coverage.command` override runs AS-IS (it must itself write
 *      `coverage/coverage-summary.json`);
 *   2. a contracted vitest test command reuses its tail (honours `--config`) plus
 *      {@link COVERAGE_FLAGS};
 *   3. a contracted NON-vitest test command cannot be derived from — fail loud,
 *      the remedy is an explicit coverage command or a waiver;
 *   4. no test override at all → the built-in `vitest run` + flags.
 */
export function resolveCoverageCommand(contract: GateContract): CoverageCommandResolution {
    const override = contractCommand(contract, 'coverage')
    if (override !== undefined) {
        return {ok: true, cmd: {kind: 'argv', argv: override}}
    }
    const test = contractCommand(contract, 'test')
    if (test === undefined) {
        return {ok: true, cmd: {kind: 'vitest', args: ['run', ...COVERAGE_FLAGS]}}
    }
    if (test[0] !== 'vitest') {
        return {
            ok: false,
            reason:
                `cannot derive a coverage command from contracted test command '${test.join(' ')}' — ` +
                'contract gates.coverage.command (it must write coverage/coverage-summary.json) ' +
                'or waive the coverage gate',
        }
    }
    // Reuse the contracted vitest invocation's tail; force the `run` subcommand so
    // a bare `vitest --config x` contract can never drop us into watch mode.
    const tail = test.slice(1)
    const args = tail[0] === 'run' ? tail : ['run', ...tail]
    return {ok: true, cmd: {kind: 'vitest', args: [...args, ...COVERAGE_FLAGS]}}
}

/** Map a non-measured answer to the failing gate detail, naming which side broke. */
function measurementFailure(which: string, m: Exclude<CoverageMeasurement, {kind: 'measured'}>): string {
    switch (m.kind) {
        case 'command-failed': {
            const out = excerpt(m.proc.stderr || m.proc.stdout)
            return (
                `coverage measurement (${which}): command failed exit=${m.proc.code ?? 'null'}` +
                (out ? `: ${out}` : '')
            )
        }
        case 'summary-missing':
            return `coverage measurement (${which}): command exited 0 but wrote no coverage/coverage-summary.json`
        case 'summary-invalid':
            return `coverage measurement (${which}): coverage/coverage-summary.json invalid (corrupt or missing a metric)`
    }
}

/**
 * One side's summary: store hit ?? measure ?? store put. Returns the summary or
 * the failing gate detail. The store is a perf cache only — absent means measure
 * uncached, never a silent skip.
 */
async function summaryFor(
    ctx: StrategyContext<GateTools>,
    which: string,
    treeSha: string,
    measure: () => Promise<CoverageMeasurement>
): Promise<CoverageSummary | {readonly failed: string}> {
    const cached = await ctx.coverageStore?.get(treeSha)
    if (cached != null) {
        return cached
    }
    const m = await measure()
    if (m.kind !== 'measured') {
        return {failed: measurementFailure(which, m)}
    }
    await ctx.coverageStore?.put(treeSha, m.summary)
    return m.summary
}

export const coverageStrategy: GateStrategy<GateTools> = {
    id: 'coverage',
    async run(ctx: StrategyContext<GateTools>): Promise<GateOutcome> {
        const opts = {cwd: ctx.worktree}
        if (ctx.contract === undefined) {
            // TODO(remove after one release): legacy pre-contract worktree — the runner
            // already warned; keep the old skip semantics for runs created before S7.
            return skip('coverage', 'no-gate-contract')
        }
        const resolution = resolveCoverageCommand(ctx.contract)
        if (!resolution.ok) {
            return ran('coverage', false, resolution.reason)
        }
        const base = await resolveBase(ctx.tools, ctx.baseRef, opts)
        if (base === null) {
            return ran('coverage', false, `base_ref_not_found: origin/${ctx.baseRef} and ${ctx.baseRef}`)
        }
        const headTree = await ctx.tools.git.treeSha(opts)
        const baseSha = await ctx.tools.git.revParse(base, opts)
        const baseTree = await ctx.tools.git.revParse(`${base}^{tree}`, opts)

        // Full suite on both sides, never diff-scoped: a delta over two different
        // scopes is meaningless, and scoping to zero files must never read as 100%.
        const head = await summaryFor(ctx, 'head', headTree, () => ctx.tools.coverage.measure(resolution.cmd, opts))
        if ('failed' in head) {
            return ran('coverage', false, head.failed)
        }
        const before = await summaryFor(ctx, `base ${baseSha}`, baseTree, () =>
            ctx.tools.coverage.measureAtBase(baseSha, resolution.cmd, opts)
        )
        if ('failed' in before) {
            // Base runs under HEAD's node_modules (symlinked): a dep-changing task can
            // break it — the remedy is an explicit coverage command or a waiver.
            return ran(
                'coverage',
                false,
                `${before.failed} — base is measured under head's node_modules; if this task changed deps, contract gates.coverage.command or waive coverage`
            )
        }

        const tolerance = ctx.config.quality.coverageRegressionTolerancePct
        const delta = coverageDelta(before, head)
        const failed = regressions(delta, tolerance)
        if (failed.length > 0) {
            const named = failed.map((m) => `${m} (${delta[m]}%)`).join(', ')
            return ran('coverage', false, `coverage decreased beyond ${tolerance}%: ${named}`)
        }
        return ran('coverage', true, `coverage within tolerance ${tolerance}%`)
    },
}
