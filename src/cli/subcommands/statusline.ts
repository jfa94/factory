/**
 * `factory statusline` — the usage-cache.json WRITER (Prompt D).
 *
 * Ports the retired `statusline-wrapper.sh`. Claude Code invokes the statusline
 * command on a cadence, piping a JSON payload to stdin. This subcommand:
 *   1. reads the whole stdin payload (may be empty / non-JSON),
 *   2. if it carries `.rate_limits`, persists `rate_limits + {captured_at}` to
 *      `${dataDir}/usage-cache.json` atomically — the ONLY producer of the cache
 *      {@link StatuslineUsageSignal} (the session-mode quota pacer) reads,
 *   3. passes the SAME payload through to `$FACTORY_ORIGINAL_STATUSLINE` (if set)
 *      and forwards ITS stdout as the displayed statusline.
 *
 * IO CONTRACT — this is NOT a machine subcommand: stdout is the DISPLAYED
 * statusline text (passthrough), never a `{kind:…}` envelope, so it never routes
 * through `emitJson`. Diagnostics go to stderr via {@link createLogger}.
 *
 * FAIL-SOFT INVARIANT — the statusline fires constantly and must NEVER crash the
 * user's statusline. Every degraded condition (empty/non-JSON stdin, missing
 * `rate_limits`, unresolvable data dir, a broken original statusline command) is
 * a clean no-op that still returns {@link EXIT.OK}; nothing here throws.
 */
import type { ExitCode } from "../../shared/exit-codes.js";
import { EXIT } from "../../shared/exit-codes.js";
import { parseArgs } from "../args.js";
import { emitLine } from "../io.js";
import { readStdin } from "../../shared/stdin.js";
import { resolveDataDir, type DataDirOptions } from "../../config/index.js";
import { usageCachePath } from "../../quota/usage-source.js";
import { atomicWriteFile } from "../../shared/atomic-write.js";
import { stringifyJson } from "../../shared/json.js";
import { nowEpoch as defaultNowEpoch } from "../../shared/time.js";
import { exec } from "../../shared/exec.js";
import { createLogger } from "../../shared/logging.js";
import type { Subcommand } from "../registry-types.js";

const log = createLogger("cli:statusline");

const HELP = `factory statusline — capture Claude Code rate limits + chain the statusline

Wire this as the Claude Code statusLine.command. On every statusline update it
reads the piped JSON payload, writes \`rate_limits + {captured_at}\` to
\${CLAUDE_PLUGIN_DATA}/usage-cache.json (the session-mode quota pacer's input),
and — if FACTORY_ORIGINAL_STATUSLINE is set — pipes the same payload to that
command and forwards its stdout as the displayed statusline.

Usage:
  factory statusline        (reads the CC payload from stdin)

This is a side-effecting passthrough, not a machine subcommand: stdout is the
displayed statusline text, NOT a JSON envelope.`;

/** Dependencies for {@link runStatusline}, all injectable for tests. */
export interface StatuslineDeps {
  /** Data-dir resolution options (env / explicit dataDir override). */
  dataDirOptions?: DataDirOptions;
  /** Injectable clock (epoch SECONDS) for deterministic tests. */
  now?: () => number;
  /** Full-payload stdin reader override (takes precedence over `stdin`). */
  readStdin?: () => Promise<string>;
  /** Raw stdin stream override, passed to the shared {@link readStdin}. */
  stdin?: AsyncIterable<string | Uint8Array>;
  /** stdout sink for the displayed statusline (defaults to process.stdout). */
  writeStdout?: (text: string) => void;
  /** Override `$FACTORY_ORIGINAL_STATUSLINE` (defaults to the real env var). */
  originalStatusline?: string;
  /**
   * Override the command runner (defaults to the shared {@link exec}). Tests inject
   * a double — e.g. one returning a timeout-killed result (`code: null`) — to drive
   * the fail-soft branches without spawning a real (slow) process.
   */
  exec?: typeof exec;
}

/** Whether a parsed payload carries a usable `rate_limits` object. */
function rateLimitsOf(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const rl = (payload as Record<string, unknown>).rate_limits;
  if (typeof rl !== "object" || rl === null) return null;
  return rl as Record<string, unknown>;
}

/**
 * Write `rate_limits + {captured_at}` to the usage cache. Best-effort: any
 * failure (unresolvable data dir, write error) is logged and swallowed — a
 * cache-write failure must never break the statusline.
 */
async function writeCache(
  rateLimits: Record<string, unknown>,
  deps: StatuslineDeps,
): Promise<void> {
  let dataDir: string;
  try {
    dataDir = resolveDataDir(deps.dataDirOptions ?? {});
  } catch {
    // No data dir resolvable → the cache cannot be located. Skip (the bash guard
    // skipped on an unset CLAUDE_PLUGIN_DATA for the same reason).
    log.warn("CLAUDE_PLUGIN_DATA unresolvable; skipping usage-cache.json write");
    return;
  }

  const now = (deps.now ?? defaultNowEpoch)();
  const cache = { ...rateLimits, captured_at: now };
  try {
    await atomicWriteFile(usageCachePath(dataDir), stringifyJson(cache));
  } catch (err) {
    log.warn(`failed to write usage-cache.json: ${(err as Error).message}`);
  }
}

/**
 * Pass the payload through to `$FACTORY_ORIGINAL_STATUSLINE` and forward its
 * stdout. Returns the text to display (empty string if no original is set or it
 * fails). Best-effort: a missing/failing command degrades to an empty display
 * rather than throwing.
 */
async function passthrough(payload: string, deps: StatuslineDeps): Promise<string> {
  const original = deps.originalStatusline ?? process.env.FACTORY_ORIGINAL_STATUSLINE ?? "";
  if (original.trim().length === 0) return "";

  try {
    // Run through a shell so the user's command string (which may carry args and
    // a leading `~`) is honored, matching the old wrapper's argv expansion. The
    // value is operator-supplied via settings.json env, not attacker-controlled.
    // Hard 3s timeout so a hung original command can't stall EVERY statusline tick;
    // on expiry the child is signal-killed (code: null), which the code-!==-0 branch
    // below already converts to a fail-soft empty display.
    const run = deps.exec ?? exec;
    const result = await run(original, [], { shell: true, input: payload, timeoutMs: 3000 });
    if (result.code !== 0) {
      const why =
        result.code === null
          ? `was killed by signal ${result.signal ?? "unknown"} (likely the 3s timeout)`
          : `exited ${result.code}`;
      log.warn(`FACTORY_ORIGINAL_STATUSLINE ${why}; statusline left empty`);
      return "";
    }
    return result.stdout;
  } catch (err) {
    // Spawn failure (e.g. ENOENT for a missing binary) — never crash the statusline.
    log.warn(`FACTORY_ORIGINAL_STATUSLINE failed to run: ${(err as Error).message}`);
    return "";
  }
}

/**
 * Run the statusline subcommand end-to-end. Reads the payload, writes the cache
 * (when present), and emits the (possibly passed-through) displayed statusline.
 * Never throws; always returns {@link EXIT.OK} — the statusline must not break.
 */
export async function runStatusline(
  argv: string[] = [],
  deps: StatuslineDeps = {},
): Promise<ExitCode> {
  const args = parseArgs(argv);
  if (args.flag("help") === true) {
    emitLine(HELP);
    return EXIT.OK;
  }

  // 1. Read the whole stdin payload (may be empty).
  const payload = deps.readStdin ? await deps.readStdin() : await readStdin(deps.stdin);

  // 2. Write the cache iff the payload parses to an object carrying rate_limits.
  //    A non-JSON or rate_limits-less payload is a clean no-op for the cache.
  let parsed: unknown;
  try {
    parsed = payload.trim().length > 0 ? JSON.parse(payload) : undefined;
  } catch {
    parsed = undefined; // non-JSON stdin → no cache write (still passthrough below).
  }
  const rateLimits = rateLimitsOf(parsed);
  if (rateLimits !== null) {
    await writeCache(rateLimits, deps);
  }

  // 3. Emit the displayed statusline (original's stdout, or empty).
  const displayed = await passthrough(payload, deps);
  const write = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
  write(displayed);

  return EXIT.OK;
}

export const statuslineCommand: Subcommand = {
  describe: "Capture Claude Code rate limits to usage-cache.json + chain the statusline",
  run: (argv) => runStatusline(argv),
};
