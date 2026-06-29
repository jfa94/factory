/**
 * WS6 — unit-test gate strategy (Δ O diff-scoped unit).
 *
 * Runs vitest scoped to the CHANGED test files (diff-scoped unit). observed = the
 * run exited 0. There is no "package.json" probe here in the pure-tools model —
 * applicability is decided by the runner's enablement config; this strategy
 * reports the machine result. When there are no changed test files the run is
 * un-scoped (full suite), matching "un-scoped integration" semantics.
 */
import type { GateOutcome, GateStrategy, StrategyContext } from "../strategy.js";
import { ran } from "../strategy.js";
import { diffScopedTestFiles, isVitestRunnable } from "../scope.js";
import type { GateTools } from "../tools.js";

export const testStrategy: GateStrategy<GateTools> = {
  id: "test",
  async run(ctx: StrategyContext<GateTools>): Promise<GateOutcome> {
    const base = `origin/${ctx.baseRef}`;
    const changed = await ctx.tools.git.changedFiles(base, { cwd: ctx.worktree });
    const scoped = diffScopedTestFiles(changed);
    const runnable = scoped.filter(isVitestRunnable);
    // Only non-JS/TS tests changed (e.g. pure pgTAP under supabase/tests/): vitest
    // can't run them. The tdd gate owns test EXISTENCE; this gate is EXECUTION-only
    // → vacuous pass, surfaced in detail. Non-JS green-ness is delegated to the
    // reviewer panel + the target repo's own CI (which runs pgTAP / Go / etc.).
    if (scoped.length > 0 && runnable.length === 0) {
      return ran(
        "test",
        true,
        `diff-scoped: ${scoped.length} non-vitest test file(s) not executed (e.g. pgTAP)`,
      );
    }
    const result = await ctx.tools.vitest.run(runnable, { cwd: ctx.worktree });
    if (result.truncated) {
      throw new Error("test gate: vitest output truncated — refusing to judge a clipped run");
    }
    const observed = result.code === 0;
    const detail =
      runnable.length > 0 ? `diff-scoped (${runnable.length} test file(s))` : "un-scoped";
    return ran("test", observed, `vitest exit=${result.code ?? "null"} ${detail}`);
  },
};
