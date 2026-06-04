/**
 * WS6 — build gate strategy. `npm run build`; observed = exit 0.
 */
import type { GateOutcome, GateStrategy, StrategyContext } from "../strategy.js";
import { ran } from "../strategy.js";
import type { GateTools } from "../tools.js";

export const buildStrategy: GateStrategy<GateTools> = {
  id: "build",
  async run(ctx: StrategyContext<GateTools>): Promise<GateOutcome> {
    const result = await ctx.tools.build.build({ cwd: ctx.worktree });
    if (result.truncated) {
      throw new Error("build gate: build output truncated — refusing to judge a clipped run");
    }
    return ran("build", result.code === 0, `build exit=${result.code ?? "null"}`);
  },
};
