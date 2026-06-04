/**
 * `src/cli` — public CLI seam. Downstream registers subcommands via
 * {@link cliRegistry} and shares the {@link EXIT} codes.
 */
export { dispatch, cliRegistry } from "./main.js";
export type { Subcommand } from "./main.js";
export { EXIT, isExitCode } from "./exit-codes.js";
export type { ExitCode } from "./exit-codes.js";
