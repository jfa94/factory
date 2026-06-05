/**
 * WS6 — lint gate strategy. eslint (+ dependency-cruiser where the EslintTool
 * wraps it); observed = exit 0.
 */
import type { GateStrategy } from "../strategy.js";
import type { GateTools } from "../tools.js";
import { procStrategy } from "./proc-strategy.js";

export const lintStrategy: GateStrategy<GateTools> = procStrategy("lint", "eslint", (tools, opts) =>
  tools.eslint.lint(opts),
);
