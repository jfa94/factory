/**
 * Factory CLI — importable subcommand registry + `dispatch()`.
 *
 * The registry is a FROZEN seam: downstream workstreams register their
 * subcommands by importing {@link cliRegistry} and adding entries (e.g.
 * `factory run-task`, `factory state`, `factory quota-gate`). `dispatch()`
 * returns a numeric {@link ExitCode}; the thin entry `src/bin/factory.ts` is the
 * ONLY place that calls `process.exit` with it.
 *
 * Conventions:
 *   - `--help` / `-h` / no args  → print the registry, return EXIT.OK.
 *   - unknown subcommand         → stderr message, return EXIT.USAGE.
 *   - a subcommand's own errors  → it returns EXIT.ERROR (or throws, which the
 *                                  entry maps to EXIT.ERROR).
 */
import { EXIT, type ExitCode } from "./exit-codes.js";
import { loadConfig } from "../config/index.js";
import { stringifyJson } from "../shared/json.js";
import { configureCommand } from "./subcommands/configure.js";
import { stateCommand } from "./subcommands/state.js";
import { scaffoldCommand } from "./subcommands/scaffold.js";
import { runTaskCommand } from "./subcommands/run-task.js";
import { advanceCommand } from "./subcommands/advance.js";
import { dropCommand } from "./subcommands/drop.js";
import { recordProducerCommand } from "./subcommands/record-producer.js";
import { recordHoldoutCommand } from "./subcommands/record-holdout.js";
import { recordReviewsCommand } from "./subcommands/record-reviews.js";
import { runCommand } from "./subcommands/run.js";
import { specCommand } from "./subcommands/spec.js";
import { rescueCommand } from "./subcommands/rescue.js";
import { scoreCommand } from "./subcommands/score.js";
import { driveCommand } from "./subcommands/drive.js";
import { nextCommand } from "./subcommands/next.js";

/** A single CLI subcommand. `run` returns (or resolves to) an {@link ExitCode}. */
export interface Subcommand {
  /** One-line description shown in `--help`. */
  describe: string;
  /** Execute the subcommand with its remaining argv (after the name). */
  run: (argv: string[]) => Promise<ExitCode> | ExitCode;
}

/** The mutable subcommand registry. Downstream WS add entries to this object. */
export const cliRegistry: Record<string, Subcommand> = {
  "config-defaults": {
    describe: "Print the resolved config (defaults + any config.json) as JSON",
    run: () => {
      // Doubles as a live smoke test of the config schema + loader. loadConfig
      // returns all-defaults when no data dir / config file is present.
      const cfg = loadConfig();
      process.stdout.write(stringifyJson(cfg));
      return EXIT.OK;
    },
  },
  configure: configureCommand,
  run: runCommand,
  spec: specCommand,
  rescue: rescueCommand,
  score: scoreCommand,
  state: stateCommand,
  scaffold: scaffoldCommand,
  "run-task": runTaskCommand,
  advance: advanceCommand,
  drop: dropCommand,
  "record-producer": recordProducerCommand,
  "record-holdout": recordHoldoutCommand,
  "record-reviews": recordReviewsCommand,
  drive: driveCommand,
  next: nextCommand,
};

function printHelp(): void {
  const names = Object.keys(cliRegistry).sort();
  const width = names.reduce((m, n) => Math.max(m, n.length), 0);
  const lines: string[] = [
    "factory — autonomous coding pipeline CLI",
    "",
    "Usage: factory <subcommand> [options]",
    "",
    "Subcommands:",
    ...names.map((n) => `  ${n.padEnd(width)}  ${cliRegistry[n]!.describe}`),
    "",
    "Run `factory <subcommand> --help` for subcommand-specific help.",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

/**
 * Dispatch a factory CLI invocation. `argv` is `process.argv.slice(2)`.
 * Returns the exit code; never calls `process.exit` itself.
 */
export async function dispatch(argv: string[]): Promise<ExitCode> {
  const [name, ...rest] = argv;

  if (name === undefined || name === "--help" || name === "-h") {
    printHelp();
    return EXIT.OK;
  }

  const cmd = cliRegistry[name];
  if (!cmd) {
    process.stderr.write(
      `factory: unknown subcommand '${name}'. Run \`factory --help\` for usage.\n`,
    );
    return EXIT.USAGE;
  }

  return cmd.run(rest);
}
