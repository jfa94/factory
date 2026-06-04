/**
 * `src/hooks` — public hook seam. WS9 registers guards via {@link hookRegistry}
 * and exports each guard's importable body + the TCB core for direct unit tests
 * and for WS10 to wire into hooks.json later.
 */
export { dispatchHook, hookRegistry } from "./main.js";
export type { Hook } from "./main.js";

// Guard bodies (importable, directly unit-testable).
export { runBranchProtection, decideBranchProtection } from "./branch-protection.js";
export { runWriteProtection, decideWriteProtection } from "./write-protection.js";
export { runHoldoutGuard, decideHoldoutGuard } from "./holdout-guard.js";
export { runSecretGuard, decideSecretGuard } from "./secret-guard.js";
export { runPipelineGuards, decidePipelineGuards } from "./pipeline-guards.js";
export { runSubagentStop, handleSubagentStop } from "./subagent-stop.js";

// TCB core (the hardcoded denylist) + hook I/O helpers.
export { isTcbProtected, buildTcbRules, canonicalizePath, TCB_DENY } from "./tcb.js";
export type { TcbCategory, TcbRule, TcbMatch, TcbContext } from "./tcb.js";
export {
  parseHookInput,
  readHookInput,
  allow,
  deny,
  isDeny,
  emitPermissionDecision,
  emitBlockDecision,
  decisionToExitCode,
  HookInputError,
} from "./hook-io.js";
export type { HookInput, HookDecision } from "./hook-io.js";

// Shared bypass + git-arg parsers.
export { isNestedShellOrHookBypass, matchBypass, BYPASS_PATTERNS } from "./shell-bypass.js";
export { parseGitInvocation } from "./git-args.js";
export type { GitInvocation } from "./git-args.js";

// Active-run context resolution.
export {
  loadActiveRun,
  resolveActiveTask,
  isTestWriterPhase,
  BrokenRunStateError,
} from "./hook-context.js";
