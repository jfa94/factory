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
import {redactSecrets} from '../../../shared/index.js'
import {contractCommand} from '../gate-contract.js'
import type {GateId} from '../gate-id.js'
import type {GateOutcome, GateStrategy, StrategyContext} from '../strategy.js'
import {ran} from '../strategy.js'
import type {GateTools, ProcResult, ToolRunOpts} from '../tools.js'

/** Cap for the stderr/stdout excerpt appended to a failing gate's detail (chars). */
const EXCERPT_MAX_CHARS = 1000

/**
 * Scrub secrets, then trim + cap raw process output for a gate's detail (fix-forward
 * channel). Redaction is unconditional here (unlike sast.ts's config-gated scrub): a
 * gate detail flows verbatim to the run's failure_reason and is auto-posted to the
 * originating PRD issue comment (world-readable on a public repo), so build/lint/type/
 * coverage stderr must never carry an env secret to that sink. Both callers
 * (procOutcome, coverage's measurementFailure) route through here.
 */
export function excerpt(text: string): string {
    const trimmed = redactSecrets(text).trim()
    if (trimmed.length <= EXCERPT_MAX_CHARS) {
        return trimmed
    }
    return `${trimmed.slice(0, EXCERPT_MAX_CHARS)}… (truncated)`
}

/**
 * Map a finished process result to a {@link GateOutcome}: fail LOUD on truncation
 * (never judge a clipped run), else observed = `exit 0` with a `<label> exit=<code>`
 * detail. On a FAILING run, the detail also carries a capped stderr (falling back to
 * stdout) excerpt — this is the only place the concrete lint/tsc/build error text is
 * available; without it here, fix-forward (prompt-context.ts's confirmedBlockers →
 * fixInstructions) has nothing but the bare exit code to hand the next producer rung.
 * A passing run's detail is unchanged (nothing to fix). Exported so a gate with a
 * pre-run applicability check (e.g. lint) reuses the exact same mapping for its run path.
 */
export function procOutcome(id: GateId, label: string, result: ProcResult): GateOutcome {
    if (result.truncated) {
        throw new Error(`${id} gate: ${label} output truncated — refusing to judge a clipped run`)
    }
    const base = `${label} exit=${result.code ?? 'null'}`
    if (result.code === 0) {
        return ran(id, true, base)
    }
    const output = excerpt(result.stderr || result.stdout)
    return ran(id, false, output ? `${base}: ${output}` : base)
}

/** Build a process-gate strategy from its id, label, and tool invocation. */
export function procStrategy(
    id: GateId,
    label: string,
    invoke: (tools: GateTools, opts: ToolRunOpts) => Promise<ProcResult>
): GateStrategy<GateTools> {
    return {
        id,
        async run(ctx: StrategyContext<GateTools>): Promise<GateOutcome> {
            const opts = {cwd: ctx.worktree}
            // Gate contract (S7, Decision 46): a contracted `command` override replaces
            // the built-in tool — `deno check .` instead of tsc, `deno task build`
            // instead of npm run build.
            const command = contractCommand(ctx.contract, id)
            if (command !== undefined) {
                return procOutcome(id, `contract:${command.join(' ')}`, await ctx.tools.command.run(command, opts))
            }
            return procOutcome(id, label, await invoke(ctx.tools, opts))
        },
    }
}
