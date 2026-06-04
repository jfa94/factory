/**
 * WS6 — lint gate strategy. eslint (+ dependency-cruiser where the EslintTool
 * wraps it); observed = exit 0.
 */
import type { GateOutcome, GateStrategy, StrategyContext } from "../strategy.js";
import { ran } from "../strategy.js";
import type { GateTools } from "../tools.js";

export const lintStrategy: GateStrategy<GateTools> = {
  id: "lint",
  async run(ctx: StrategyContext<GateTools>): Promise<GateOutcome> {
    const result = await ctx.tools.eslint.lint({ cwd: ctx.worktree });
    if (result.truncated) {
      throw new Error("lint gate: eslint output truncated — refusing to judge a clipped run");
    }
    return ran("lint", result.code === 0, `eslint exit=${result.code ?? "null"}`);
  },
};
