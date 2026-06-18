/**
 * `factory score [--run <id>] [--dead-surface]` — the run-outcome REPORTER (WS12,
 * Decision 22, Δ S).
 *
 * Model A: a read-only reporter. It resolves the run + its durable spec, derives the
 * deterministic partial-run report, and folds it into the compact {@link RunSummary}
 * the orchestrator surfaces. Nothing here writes state.
 *
 * `--dead-surface` additionally enumerates unreferenced exports in the run diff
 * (`ts-prune`, scoped to the changed files). It is REPORT-ONLY and best-effort: the
 * git probe that resolves the diff is wrapped so a probe failure degrades to an
 * `error` entry rather than crashing the report; `scanDeadSurface` itself never
 * throws (a missing tool is `skipped`).
 */
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError, UsageError, optionalString } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { loadConfig, resolveDataDir } from "../../config/index.js";
import { StateManager } from "../../core/state/index.js";
import { readCurrentForCwd, type CurrentRunOverrides } from "../current.js";
import { SpecStore } from "../../spec/index.js";
import { DefaultGitProbe } from "../../verifier/deterministic/index.js";
import {
  buildPartialReport,
  buildRunSummary,
  scanDeadSurface,
  TsPruneRunner,
  type DeadSurfaceReport,
} from "../../scoring/index.js";
import type { Subcommand } from "../main.js";

const HELP = `factory score — report a run's outcome summary (read-only)

Usage:
  factory score [--run <id>] [--dead-surface] [--base <ref>] [--project-root <dir>]

  --run            The run to score (defaults to runs/current).
  --dead-surface   Also enumerate unreferenced exports in the run diff (report-only).
  --base           Diff base for --dead-surface (default: origin/<git.baseBranch>).
  --project-root   Repo checkout to scan for --dead-surface (default: cwd).

Emits ONE JSON document:
  { kind:"score", summary, dead_surface? }`;

export async function runScore(
  argv: string[],
  overrides: CurrentRunOverrides = {},
): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: ["dead-surface"] });
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

  let deadSurface: DeadSurfaceReport | undefined;
  if (args.flag("dead-surface") === true) {
    const config = loadConfig({ dataDir });
    const base = optionalString(args.flag("base")) ?? `origin/${config.git.baseBranch}`;
    const cwd = optionalString(args.flag("project-root")) ?? process.cwd();
    deadSurface = await scoreDeadSurface(base, cwd);
  }

  emitJson({
    kind: "score",
    summary,
    ...(deadSurface !== undefined ? { dead_surface: deadSurface } : {}),
  });
  return EXIT.OK;
}

/**
 * Resolve the run diff and run the report-only dead-surface scan. The git probe is
 * the only throw source (scanDeadSurface never throws); a probe failure (no such
 * base ref, not a repo) degrades to an `error` report rather than failing `score`.
 */
async function scoreDeadSurface(base: string, cwd: string): Promise<DeadSurfaceReport> {
  let changedFiles: readonly string[];
  try {
    changedFiles = await new DefaultGitProbe().changedFiles(base, { cwd });
  } catch (err) {
    return {
      tool: "ts-prune",
      status: "error",
      changed_file_count: 0,
      total_found: 0,
      findings: [],
      note: `could not resolve the run diff against '${base}': ${(err as Error).message}`,
    };
  }
  return scanDeadSurface(new TsPruneRunner(), changedFiles, { cwd });
}

export const scoreCommand: Subcommand = {
  describe: "Report a run's outcome summary (read-only; optional --dead-surface scan)",
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
