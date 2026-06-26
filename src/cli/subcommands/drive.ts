/**
 * `factory drive --run <id> --task <id> [--results <file>] [--ship-mode <m>]` —
 * the per-task coroutine (the engine seam both drivers share).
 *
 * Runs every deterministic step it can and emits ONE JSON NextAction:
 * `spawn` (the agents to run + what to feed back), `terminal`, or
 * `quota-blocked`. Re-invoking without --results is idempotent.
 */
import { EXIT, type ExitCode } from "../../shared/exit-codes.js";
import { parseArgs, isUsageError, UsageError, parseShipMode } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { loadCoroutineDeps } from "../wiring.js";
import { nextAction, parseDriveResults, readJsonInput } from "../../driver/index.js";
import type { Subcommand } from "../registry-types.js";

const HELP = `factory drive — step one task until it needs agents or is terminal

Usage:
  factory drive --run <id> --task <id> [--results <file>] [--ship-mode <mode>]

--ship-mode (optional): no-merge | live — overrides the run's persisted ship_mode for
this step only; omit to honor the persisted value (the seam default, never no-merge).

Emits ONE JSON envelope to stdout:
  { kind:"spawn", run_id, task_id, phase, request, holdout?, expects, result_key, worktree, base_ref }
  { kind:"done", run_id, task_id, outcome }
  { kind:"pause", run_id, task_id, scope, reason, resets_at_epoch? }

--results feeds back what the previous spawn envelope asked for. It MUST echo the
envelope's result_key verbatim; a stale/duplicate key rejects LOUD (re-invoke without
--results to get the current envelope):
  expects=producer-status → { "result_key": {…}, "producer": { "status": "<STATUS line>" } }
  expects=reviews         → { "result_key": {…}, "holdout"?: {"raw": "<validator output>"},
                              "reviews": { reviews, verifications, crossVendorAbsent? } }
Re-invoking without --results re-derives the same spawn envelope (idempotent).`;

async function run(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: [] });
  if (args.flag("help") === true) {
    emitLine(HELP);
    return EXIT.OK;
  }
  const runId = args.requireFlag("run");
  const taskId = args.requireFlag("task");
  const shipMode = parseShipMode(args.flag("ship-mode"));
  const resultsPath = args.flag("results");

  let results;
  if (typeof resultsPath === "string" && resultsPath.length > 0) {
    try {
      results = parseDriveResults(await readJsonInput<unknown>(resultsPath));
    } catch (err) {
      throw new UsageError(
        `--results ${resultsPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (resultsPath !== undefined) {
    throw new UsageError("--results requires a file path");
  }

  const deps = await loadCoroutineDeps({ runId, ...(shipMode !== undefined ? { shipMode } : {}) });
  const envelope = await nextAction(deps, runId, taskId, results);
  emitJson(envelope);
  return EXIT.OK;
}

export const driveCommand: Subcommand = {
  describe: "Step one task: run deterministic steps, emit spawn/terminal/quota envelope",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`drive: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
