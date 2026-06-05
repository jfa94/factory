/**
 * WS6 — build gate strategy. `npm run build`; observed = exit 0.
 */
import type { GateStrategy } from "../strategy.js";
import type { GateTools } from "../tools.js";
import { procStrategy } from "./proc-strategy.js";

export const buildStrategy: GateStrategy<GateTools> = procStrategy(
  "build",
  "build",
  (tools, opts) => tools.build.build(opts),
);
