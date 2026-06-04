/**
 * Factory hook dispatcher — importable `dispatchHook()` + a name-keyed registry.
 *
 * Invoked (via the built `dist/factory-hook.js`) from `hooks/hooks.json` as
 * `factory-hook <name>`. The registry is a FROZEN seam: WS9 registers each guard
 * by adding `{ name: { describe, run } }` whose `run` delegates to an importable
 * `src/hooks/<name>.ts` function — so every guard is unit-testable in isolation.
 *
 * Conventions mirror the CLI:
 *   - `--help` / `-h` / no args → list hooks, return EXIT.OK.
 *   - unknown hook             → stderr, return EXIT.USAGE.
 *
 * The thin entry `src/bin/factory-hook.ts` is the only `process.exit` site.
 */
import { EXIT, type ExitCode } from "../cli/exit-codes.js";
import { runBranchProtection } from "./branch-protection.js";

/** A single hook entry. `run` returns (or resolves to) an {@link ExitCode}. */
export interface Hook {
  /** One-line description shown in `--help`. */
  describe: string;
  /** Execute the hook with its remaining argv (after the hook name). */
  run: (argv: string[]) => Promise<ExitCode> | ExitCode;
}

/** The mutable hook registry. WS9 adds the real guards here. */
export const hookRegistry: Record<string, Hook> = {
  "branch-protection": {
    describe: "Verify required branch protection is present (WS0 stub: no-op)",
    run: (argv) => runBranchProtection(argv),
  },
};

function printHelp(): void {
  const names = Object.keys(hookRegistry).sort();
  const width = names.reduce((m, n) => Math.max(m, n.length), 0);
  const lines: string[] = [
    "factory-hook — factory plugin hook dispatcher",
    "",
    "Usage: factory-hook <hook-name> [args]",
    "",
    "Hooks:",
    ...names.map((n) => `  ${n.padEnd(width)}  ${hookRegistry[n]!.describe}`),
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

/**
 * Dispatch a factory-hook invocation. `argv` is `process.argv.slice(2)`.
 * Returns the exit code; never calls `process.exit` itself.
 */
export async function dispatchHook(argv: string[]): Promise<ExitCode> {
  const [name, ...rest] = argv;

  if (name === undefined || name === "--help" || name === "-h") {
    printHelp();
    return EXIT.OK;
  }

  const hook = hookRegistry[name];
  if (!hook) {
    process.stderr.write(
      `factory-hook: unknown hook '${name}'. Run \`factory-hook --help\` for the list.\n`,
    );
    return EXIT.USAGE;
  }

  return hook.run(rest);
}
