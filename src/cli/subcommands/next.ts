/**
 * `factory next [--run <id>]` — the run-level pump: quota gate, checkpoint
 * recovery, cascade-drop, and the ready set. Emits ONE JSON NextEnvelope.
 */
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError, UsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { loadPumpDeps } from "../wiring.js";
import { pumpRun } from "../../driver/index.js";
import { StateManager } from "../../core/state/index.js";
import { resolveDataDir } from "../../config/index.js";
import type { Subcommand } from "../main.js";

const HELP = `factory next — one run-loop step: quota gate, cascade-drop, ready set

Usage:
  factory next [--run <id>]      (defaults to runs/current)

Emits ONE JSON envelope to stdout:
  { kind:"tasks-ready", run_id, ready:[...], cascade_dropped:[...] }
  { kind:"all-terminal", run_id, cascade_dropped:[...] }  → call \`factory run finalize\`
  { kind:"run-terminal", run_id, run_status }
  { kind:"quota-blocked", run_id, scope, reason, resets_at_epoch? }

Ready tasks are ordered in-flight first (crash resume), then pending (spec order).
Throws LOUD on a dependency deadlock.`;

async function run(argv: string[]): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: [] });
  if (args.flag("help") === true) {
    emitLine(HELP);
    return EXIT.OK;
  }
  const explicit = args.flag("run");
  let runId: string;
  if (typeof explicit === "string" && explicit.length > 0) {
    runId = explicit;
  } else {
    const dataDir = resolveDataDir({});
    const current = await new StateManager({ dataDir }).readCurrent();
    if (current === null) throw new UsageError("next: no --run given and no current run");
    runId = current.run_id;
  }

  const deps = await loadPumpDeps({ runId });
  emitJson(await pumpRun(deps, runId));
  return EXIT.OK;
}

export const nextCommand: Subcommand = {
  describe: "One run-loop step: quota gate, cascade-drop, emit the ready set",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`next: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
