/**
 * `factory score [--run <id>]` — the run-outcome REPORTER (WS12, Decision 22, Δ S).
 *
 * Model A: a read-only reporter. It resolves the run + its durable spec, derives the
 * deterministic partial-run report, and folds it into the compact {@link RunSummary}
 * the orchestrator surfaces. Nothing here writes state.
 */
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError, UsageError, optionalString } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { resolveDataDir } from "../../config/index.js";
import { StateManager } from "../../core/state/index.js";
import { readCurrentForCwd, type CurrentRunOverrides } from "../current.js";
import { SpecStore } from "../../spec/index.js";
import { buildPartialReport, buildRunSummary } from "../../scoring/index.js";
import type { Subcommand } from "../main.js";

const HELP = `factory score — report a run's outcome summary (read-only)

Usage:
  factory score [--run <id>]

  --run            The run to score (defaults to runs/current).

Emits ONE JSON document:
  { kind:"score", summary }`;

export async function runScore(
  argv: string[],
  overrides: CurrentRunOverrides = {},
): Promise<ExitCode> {
  const args = parseArgs(argv);
  if (args.flag("help") === true) {
    emitLine(HELP);
    return EXIT.OK;
  }

  const dataDir = resolveDataDir({});
  const state = new StateManager({ dataDir });

  const explicitRun = optionalString(args.flag("run"));
  const runState =
    explicitRun !== undefined
      ? await state.read(explicitRun)
      : await readCurrentForCwd(state, overrides);
  if (runState === null) {
    throw new UsageError("score: no --run given and no current run");
  }

  const specStore = new SpecStore({ dataDir });
  const manifest = await specStore.read(runState.spec.repo, runState.spec.spec_id);
  const report = buildPartialReport(runState, manifest);
  const summary = buildRunSummary(runState, report);

  emitJson({ kind: "score", summary });
  return EXIT.OK;
}

export const scoreCommand: Subcommand = {
  describe: "Report a run's outcome summary (read-only)",
  run: async (argv) => {
    try {
      return await runScore(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`score: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
