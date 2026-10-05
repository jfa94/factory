/**
 * Autonomous-mode signal: the single source of truth.
 *
 * The factory pipeline is designed to run unattended from a session launched with
 * the autonomous settings (which set `FACTORY_AUTONOMOUS_MODE=1`, built in memory and
 * passed inline by `factory autonomy ensure`). Hooks and `factory autonomy` read it.
 *
 * The predicate is exactly `FACTORY_AUTONOMOUS_MODE === "1"` with no bypass flag,
 * so a CI that exports the var satisfies the same check.
 */

/** The single autonomous-mode predicate: exactly `FACTORY_AUTONOMOUS_MODE === "1"`. */
export function isAutonomous(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.FACTORY_AUTONOMOUS_MODE === '1'
}
