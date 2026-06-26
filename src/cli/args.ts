/**
 * A tiny, dependency-free argv parser shared by the `factory` subcommands.
 *
 * Deliberately minimal (no library): the subcommand surface is small and the
 * grammar fixed. Supports:
 *   - positionals          (anything not starting with `-`)
 *   - `--flag value`       (space-separated)
 *   - `--flag=value`       (equals form)
 *   - `--flag` (boolean)   when the flag is declared in `booleans`
 *   - repeated flags       collected (last wins for {@link ParsedArgs.flag}, all
 *                          available via {@link ParsedArgs.all})
 *   - `--`                 ends option parsing; the rest are positionals
 *
 * A flag NOT declared boolean consumes the next token as its value; a declared
 * boolean never does. `--help`/`-h` is always recognised as a boolean.
 */
import { UsageError } from "../shared/usage-error.js";

export interface ParsedArgs {
  positionals: string[];
  /** Last value seen for a flag (or `true` for a boolean flag). */
  flag(name: string): string | boolean | undefined;
  /** All values seen for a repeated flag, in order. */
  all(name: string): string[];
  /** A required string flag/positional, with a loud error naming it. */
  requireFlag(name: string): string;
  has(name: string): boolean;
}

export interface ParseOptions {
  /** Flags that take NO value (presence ⇒ `true`). `help` is always included. */
  booleans?: readonly string[];
}

export function parseArgs(argv: readonly string[], opts: ParseOptions = {}): ParsedArgs {
  const booleans = new Set<string>(["help", "h", ...(opts.booleans ?? [])]);
  const positionals: string[] = [];
  const values = new Map<string, Array<string | boolean>>();

  const push = (name: string, value: string | boolean): void => {
    const list = values.get(name) ?? [];
    list.push(value);
    values.set(name, list);
  };

  let i = 0;
  let optionsEnded = false;
  while (i < argv.length) {
    const tok = argv[i]!;
    if (optionsEnded || !tok.startsWith("-")) {
      positionals.push(tok);
      i += 1;
      continue;
    }
    if (tok === "--") {
      optionsEnded = true;
      i += 1;
      continue;
    }
    const dashless = tok.replace(/^-+/, "");
    const eq = dashless.indexOf("=");
    if (eq >= 0) {
      push(dashless.slice(0, eq), dashless.slice(eq + 1));
      i += 1;
      continue;
    }
    if (booleans.has(dashless)) {
      push(dashless, true);
      i += 1;
      continue;
    }
    // Value flag: consume the next token (if any and not another flag).
    const next = argv[i + 1];
    if (next === undefined || (next.startsWith("-") && next !== "-")) {
      // No value available — treat as a present-but-empty flag rather than
      // silently swallowing the following flag.
      push(dashless, true);
      i += 1;
    } else {
      push(dashless, next);
      i += 2;
    }
  }

  const lastOf = (name: string): string | boolean | undefined => {
    const list = values.get(name);
    return list === undefined ? undefined : list[list.length - 1];
  };

  return {
    positionals,
    flag: lastOf,
    all: (name) => (values.get(name) ?? []).map(String),
    has: (name) => values.has(name),
    requireFlag(name) {
      const v = lastOf(name);
      if (typeof v !== "string" || v.length === 0) {
        throw new UsageError(`missing required --${name}`);
      }
      return v;
    },
  };
}

// Re-export from shared so every existing `from "./args.js"` import site keeps working.
export { UsageError, isUsageError } from "../shared/usage-error.js";

import type { ShipMode } from "../orchestrator/types.js";
import { ShipModeEnum } from "../core/state/index.js";
export type { ShipMode };

/**
 * Validate the `--ship-mode` flag; returns `undefined` when absent. Validates
 * against {@link ShipModeEnum} (the single source of truth for the closed set) so
 * adding a mode to the enum can never silently diverge from what the CLI accepts.
 */
export function parseShipMode(raw: string | boolean | undefined): ShipMode | undefined {
  if (raw === undefined) return undefined;
  const parsed = ShipModeEnum.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new UsageError(
    `unknown --ship-mode '${String(raw)}' (expected ${ShipModeEnum.options.join(" | ")})`,
  );
}

/** Coerce a flag to a non-empty string, treating a bare boolean flag as absent. */
export function optionalString(raw: string | boolean | undefined): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
