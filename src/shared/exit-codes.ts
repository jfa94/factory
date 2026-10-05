/**
 * Frozen seam: the one exit-code enum the whole system shares.
 *
 * Design rules (Decisions doc, locked decision 5):
 *  - Human-review gates are RETIRED. There is deliberately NO exit-42 / no
 *    NEEDS_DISCUSSION code. A reviewer impasse is a classified loud drop, which
 *    surfaces as {@link ExitCode.ERROR} from the CLI plus a structured report —
 *    never a special "ask a human" exit status.
 *  - Unknown / unhandled results must FAIL LOUD (throw) at the call site rather
 *    than mapping to a silent success. The phase machine (WS2) maps its
 *    PhaseResult union onto these codes; an unmapped variant throws.
 *
 * Downstream (WS2 phase-machine, WS10 orchestrators) import this and only this for
 * process exit semantics. Do not add codes without updating that mapping.
 */
export const EXIT = {
    /** Success. */
    OK: 0,
    /** Generic failure (uncaught error, classified drop, gate/verify failure). */
    ERROR: 1,
    /** Usage error: unknown subcommand/hook, bad flags, missing required arg. */
    USAGE: 2,
} as const

/** The literal union `0 | 1 | 2` of valid process exit codes. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]
