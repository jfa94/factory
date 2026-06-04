/**
 * WS6 — type-check gate strategy. `tsc --noEmit`; observed = exit 0.
 */
import type { GateOutcome, GateStrategy, StrategyContext } from "../strategy.js";
import { ran } from "../strategy.js";
import type { GateTools } from "../tools.js";

export const typeStrategy: GateStrategy<GateTools> = {
  id: "type",
  async run(ctx: StrategyContext<GateTools>): Promise<GateOutcome> {
    const result = await ctx.tools.tsc.typecheck({ cwd: ctx.worktree });
    if (result.truncated) {
      throw new Error("type gate: tsc output truncated — refusing to judge a clipped run");
    }
    return ran("type", result.code === 0, `tsc --noEmit exit=${result.code ?? "null"}`);
  },
};
