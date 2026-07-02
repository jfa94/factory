/**
 * `factory next-action --run <id> --task <id> [--results <file>] [--ship-mode <m>]` —
 * the per-task orchestrator (the engine seam both runners share).
 *
 * Runs every deterministic step it can and emits ONE JSON NextAction:
 * `spawn` (the agents to run + what to feed back), `terminal`, or
 * `quota-blocked`. Re-invoking without --results is idempotent.
 */
import { EXIT, type ExitCode } from "../../shared/exit-codes.js";
import { parseArgs, parseShipMode, parseResultsFlag } from "../args.js";
import { emitJson, emitLine } from "../io.js";
import { loadOrchestratorDeps } from "../wiring.js";
import { nextAction, parseDriveResults, readJsonInput } from "../../orchestrator/index.js";
import { withUsageGuard, type Subcommand } from "../registry-types.js";

const HELP = `factory next-action — step one task until it needs agents or is terminal

Usage:
  factory next-action --run <id> --task <id> [--results <file>] [--ship-mode <mode>]

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
  const results = await parseResultsFlag(args, async (path) =>
    parseDriveResults(await readJsonInput<unknown>(path)),
  );

  const deps = await loadOrchestratorDeps({
    runId,
    ...(shipMode !== undefined ? { shipMode } : {}),
  });
  const envelope = await nextAction(deps, runId, taskId, results);
  emitJson(envelope);
  return EXIT.OK;
}

export const driveCommand: Subcommand = {
  describe: "Step one task: run deterministic steps, emit spawn/terminal/quota envelope",
  run: withUsageGuard("next-action", run),
};
