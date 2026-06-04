/**
 * `src/hooks` — public hook seam. WS9 registers guards via {@link hookRegistry}.
 */
export { dispatchHook, hookRegistry } from "./main.js";
export type { Hook } from "./main.js";
export { runBranchProtection } from "./branch-protection.js";
