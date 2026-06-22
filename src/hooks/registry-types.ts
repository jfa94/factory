/**
 * Leaf module holding the hook registry's structural interface.
 *
 * Sibling of `src/cli/registry-types.ts`. `main.ts` imports every guard body, so
 * holding {@link Hook} here (a dependency-free leaf importing only `ExitCode`)
 * lets a future guard type itself as `Hook` by importing DOWN, without forming the
 * `main.ts ↔ guard` cycle that the CLI registry suffered. `madge --circular`
 * enforces the no-cycle bar in `npm run verify`.
 */
import type { ExitCode } from "../shared/exit-codes.js";

/** A single hook entry. `run` returns (or resolves to) an {@link ExitCode}. */
export interface Hook {
  /** One-line description shown in `--help`. */
  describe: string;
  /** Execute the hook with its remaining argv (after the hook name). */
  run: (argv: string[]) => Promise<ExitCode> | ExitCode;
}
