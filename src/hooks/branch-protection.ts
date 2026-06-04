/**
 * Example hook module: `branch-protection`.
 *
 * Hook LOGIC lives as importable, directly-unit-testable `src/hooks/<name>.ts`
 * functions (the WS9 requirement). `main.ts` only wires name → function. In WS0
 * this is a no-op stub returning EXIT.OK so the dispatcher + acceptance test have
 * a real hook to exercise; WS9 fills in the actual branch-protection guard body.
 */
import { EXIT, type ExitCode } from "../cli/exit-codes.js";

/**
 * Run the branch-protection guard. WS0 stub: always succeeds.
 * @param _argv remaining argv after the hook name (unused in the stub).
 */
export function runBranchProtection(_argv: string[]): ExitCode {
  return EXIT.OK;
}
