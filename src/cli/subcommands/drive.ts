/**
 * `factory drive --run <id> --task <id> [--results <file>] [--ship-mode <m>]` —
 * the per-task coroutine pump (the engine seam both drivers share).
 *
 * Runs every deterministic step it can and emits ONE JSON DriveEnvelope:
 * `spawn` (the agents to run + what to feed back), `terminal`, or
 * `quota-blocked`. Re-invoking without --results is idempotent.
 */
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError, UsageError, parseShipMode } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { loadPumpDeps } from "../wiring.js";
import { pumpTask, parseDriveResults, readJsonInput } from "../../driver/index.js";
import type { Subcommand } from "../main.js";

const HELP = `factory drive — pump one task until it needs agents or is terminal

Usage:
  factory drive --run <id> --task <id> [--results <file>] [--ship-mode <mode>]

Ship modes: no-merge (default) | live

Emits ONE JSON envelope to stdout:
  { kind:"spawn", run_id, task_id, stage, manifest, sidecar?, expects, fold_key, worktree }
  { kind:"terminal", run_id, task_id, outcome }
  { kind:"quota-blocked", run_id, task_id, scope, reason, resets_at_epoch? }

--results feeds back what the previous spawn envelope asked for. It MUST echo the
envelope's fold_key verbatim; a stale/duplicate key rejects LOUD (re-invoke without
--results to get the current envelope):
  expects=producer-status → { "fold_key": {…}, "producer": { "status": "<STATUS line>" } }
  expects=reviews         → { "fold_key": {…}, "holdout"?: {"raw": "<validator output>"},
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

  const deps = await loadPumpDeps({ runId, ...(shipMode !== undefined ? { shipMode } : {}) });
  const envelope = await pumpTask(deps, runId, taskId, results);
  emitJson(envelope);
  return EXIT.OK;
}

export const driveCommand: Subcommand = {
  describe: "Pump one task: run deterministic steps, emit spawn/terminal/quota envelope",
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
