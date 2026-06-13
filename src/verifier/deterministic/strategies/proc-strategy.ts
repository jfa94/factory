/**
 * WS6 — shared body for the exit-0 PROCESS gates (build / lint / type).
 *
 * These three gates are identical apart from (a) the gate id, (b) the human label
 * used in the detail/throw text, and (c) which injected tool method they invoke.
 * Factoring the shared body here removes the 1:1 copy-paste: each gate becomes a
 * one-line {@link procStrategy} call. The contract is preserved exactly — fail
 * LOUD on truncated output (never judge a clipped run), else report observed =
 * `exit 0` with a `<label> exit=<code>` detail.
 */
import type { GateId } from "../gate-id.js";
import type { GateOutcome, GateStrategy, StrategyContext } from "../strategy.js";
import { ran } from "../strategy.js";
import type { GateTools, ProcResult, ToolRunOpts } from "../tools.js";

/**
 * Map a finished process result to a {@link GateOutcome}: fail LOUD on truncation
 * (never judge a clipped run), else observed = `exit 0` with a `<label> exit=<code>`
 * detail. Exported so a gate with a pre-run applicability check (e.g. lint) reuses
 * the exact same mapping for its run path.
 */
export function procOutcome(id: GateId, label: string, result: ProcResult): GateOutcome {
  if (result.truncated) {
    throw new Error(`${id} gate: ${label} output truncated — refusing to judge a clipped run`);
  }
  return ran(id, result.code === 0, `${label} exit=${result.code ?? "null"}`);
}

/** Build a process-gate strategy from its id, label, and tool invocation. */
export function procStrategy(
  id: GateId,
  label: string,
  invoke: (tools: GateTools, opts: ToolRunOpts) => Promise<ProcResult>,
): GateStrategy<GateTools> {
  return {
    id,
    async run(ctx: StrategyContext<GateTools>): Promise<GateOutcome> {
      return procOutcome(id, label, await invoke(ctx.tools, { cwd: ctx.worktree }));
    },
  };
}
