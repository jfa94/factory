/**
 * WS6 — lint gate strategy. eslint (+ dependency-cruiser where the EslintTool
 * wraps it); observed = exit 0.
 *
 * Applicability (Δ skip): a project that never opted into eslint must NOT fail-close
 * every task. The gate is applicable ONLY when BOTH (a) an eslint config is present
 * in the worktree AND (b) the eslint binary resolves there; otherwise it SKIPS
 * (excluded from the conjunction), mirroring the sast "no-security-command"
 * precedent. When applicable and eslint reports problems (exit≠0), it fail-closes.
 */
import type { GateOutcome, GateStrategy, StrategyContext } from "../strategy.js";
import { skip } from "../strategy.js";
import type { GateTools } from "../tools.js";
import { procOutcome } from "./proc-strategy.js";

/** eslint config filenames (flat + legacy) that mark lint as opted-in. */
export const ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  ".eslintrc.json",
  ".eslintrc",
] as const;

/** Worktree-relative path the eslint binary resolves to after `npm install`. */
export const ESLINT_BIN = "node_modules/.bin/eslint";

export const lintStrategy: GateStrategy<GateTools> = {
  id: "lint",
  async run(ctx: StrategyContext<GateTools>): Promise<GateOutcome> {
    const opts = { cwd: ctx.worktree };
    const hasBin = await ctx.tools.fs.exists(ESLINT_BIN, opts);
    if (!hasBin) {
      return skip("lint", "no-eslint-binary");
    }
    const hasConfig = await ctx.tools.fs.existsAny(ESLINT_CONFIGS, opts);
    if (!hasConfig) {
      return skip("lint", "no-eslint-config");
    }
    return procOutcome("lint", "eslint", await ctx.tools.eslint.lint(opts));
  },
};
