/**
 * Leaf module holding the CLI registry's structural interface.
 *
 * Extracted from `main.ts` so each subcommand module imports the {@link Subcommand}
 * shape DOWN from a dependency-free leaf instead of UP from `main.ts`. `main.ts`
 * imports every subcommand object, so a subcommand importing `Subcommand` from
 * `main.ts` formed a (type-only) import cycle — one per subcommand, 11 in total.
 * This leaf breaks all of them: it imports nothing but the `ExitCode` type.
 * `madge --circular` enforces the no-cycle bar in `npm run verify`.
 */
import type { ExitCode } from "../shared/exit-codes.js";

/** A single CLI subcommand. `run` returns (or resolves to) an {@link ExitCode}. */
export interface Subcommand {
  /** One-line description shown in `--help`. */
  describe: string;
  /** Execute the subcommand with its remaining argv (after the name). */
  run: (argv: string[]) => Promise<ExitCode> | ExitCode;
}
