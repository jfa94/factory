/**
 * WS6 — unit-test gate strategy (Δ O diff-scoped unit).
 *
 * Runs vitest scoped to the CHANGED test files (diff-scoped unit). observed = the
 * run exited 0. There is no "package.json" probe here in the pure-tools model —
 * applicability is decided by the runner's enablement config; this strategy
 * reports the machine result. When there are no changed test files the run is
 * un-scoped (full suite), matching "un-scoped integration" semantics.
 */
import {contractCommand} from '../gate-contract.js'
import type {GateOutcome, GateStrategy, StrategyContext} from '../strategy.js'
import {ran, skip} from '../strategy.js'
import {diffScopedTestFiles} from '../scope.js'
import type {GateTools} from '../tools.js'
import {excerpt, procOutcome} from './proc-strategy.js'

/**
 * Can vitest execute this file? Only the JS/TS family. pgTAP (`*.test.sql`),
 * Go (`*_test.go`), etc. pass {@link import("../scope.js").isTestPath} (the tdd
 * gate classifies them as test commits) but vitest can't run them.
 * Declaration files (`.d.ts`) match `.ts$` but contain no test blocks → exit 1.
 */
export function isVitestRunnable(file: string): boolean {
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file) && !file.endsWith('.d.ts')
}

export const testStrategy: GateStrategy<GateTools> = {
    id: 'test',
    async run(ctx: StrategyContext<GateTools>): Promise<GateOutcome> {
        // Gate contract (S7, Decision 46): a contracted `command` override runs the
        // FULL suite — no vitest diff-scoping (`deno test` etc. cannot be scoped by
        // vitest file rules, and scoping to zero files must never read as "passed").
        const command = contractCommand(ctx.contract, 'test')
        if (command !== undefined) {
            return procOutcome(
                'test',
                `contract:${command.join(' ')}`,
                await ctx.tools.command.run(command, {cwd: ctx.worktree})
            )
        }
        const base = `origin/${ctx.baseRef}`
        const changed = await ctx.tools.git.changedFiles(base, {cwd: ctx.worktree})
        const scoped = diffScopedTestFiles(changed)
        const runnable = scoped.filter(isVitestRunnable)
        // Only non-JS/TS tests changed (e.g. pure pgTAP, Go, declaration files):
        // vitest can't execute them and "nothing ran" must never read as "passed".
        // Skip so the gate is excluded from the conjunction — the same mechanism
        // mutation/coverage/lint use for "not applicable". The tdd gate owns test
        // EXISTENCE; non-JS green-ness is delegated to the reviewer panel + the
        // target repo's own CI (which runs pgTAP / Go / etc.).
        if (scoped.length > 0 && runnable.length === 0) {
            return skip('test', 'no-vitest-runnable-tests-in-scope')
        }
        const result = await ctx.tools.vitest.run(runnable, {cwd: ctx.worktree})
        if (result.truncated) {
            throw new Error('test gate: vitest output truncated — refusing to judge a clipped run')
        }
        const observed = result.code === 0
        const skipped = scoped.length - runnable.length
        const scope = runnable.length > 0 ? `diff-scoped (${runnable.length} test file(s))` : 'un-scoped'
        const detail =
            `vitest exit=${result.code ?? 'null'} ${scope}` +
            (skipped > 0 ? `; ${skipped} non-vitest file(s) not executed` : '')
        if (observed) {
            return ran('test', true, detail)
        }
        // vitest's default reporter writes the failing-assertion summary to STDOUT (stderr
        // carries Node warnings/uncaught errors) — stdout-first, the mirror of proc-strategy's
        // stderr-first for tsc/eslint. Without this the fix-forward channel (composeFixFindings
        // → fixInstructions) has nothing but the bare exit code to hand the next producer rung.
        const output = excerpt(result.stdout || result.stderr)
        return ran('test', false, output ? `${detail}: ${output}` : detail)
    },
}
