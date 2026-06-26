/**
 * `factory rescue <scan|apply>` — recover a run that `factory run resume` cannot
 * untangle (Decision 22, Δ S). Resume only clears the quota gate; it never touches
 * task state. When a crashed/suspended session left tasks STUCK mid-phase (so a
 * re-drive would deadlock), rescue is the seam that resets them.
 *
 * Model A: this CLI is a REPORTER (`scan`) + a WRITER (`apply`), never an agent
 * spawner. `scan` emits the pure {@link scanRun} classification — the input the
 * orchestrator (and, for ambiguous drops, the orchestrator-spawned rescue-diagnostic
 * agent) reasons over; the diagnostic then drives `apply --task …`. The CLI provides
 * scan (its input) + apply (the consumer of its decisions); it does NOT run the
 * diagnostic itself.
 */
import { EXIT, type ExitCode } from "../../shared/exit-codes.js";
import { parseArgs, isUsageError, UsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { StateManager } from "../../core/state/index.js";
import { readCurrentForCwd, type CurrentRunOverrides } from "../current.js";
import { scanRun, applyRescue, assessWork, type WorkProbe } from "../../rescue/index.js";
import { DefaultGitClient } from "../../git/index.js";
import type { Subcommand } from "../registry-types.js";

const RESCUE_HELP = `factory rescue — scan or recover a stalled run

Usage:
  factory rescue scan  [--run <id>]
  factory rescue apply [--run <id>] [--task <id>]... [--include-dead-ends]

Actions:
  scan    Classify every task (read-only); report what a re-drive would do.
  apply   Reset the resettable tasks to pending; reopen a terminal run.`;

const SCAN_HELP = `factory rescue scan — classify a stalled run (read-only)

Usage:
  factory rescue scan [--run <id>]

  --run   The run to scan (defaults to runs/current).

Emits ONE JSON document: the RescueScan (counts, resettable, dead_ends,
needs_rescue, would_deadlock, summary, per-task lines). Writes nothing.`;

const APPLY_HELP = `factory rescue apply — reset resettable tasks and reopen a terminal run

Usage:
  factory rescue apply [--run <id>] [--task <id>]... [--include-dead-ends]

  --run                The run to recover (defaults to runs/current).
  --task               Reset exactly this task (repeatable). Overrides the default
                       resettable set; a 'done' task is a loud error, a 'pending'
                       one is skipped. An explicitly-named dead-end IS reset.
  --include-dead-ends  Also reset dead-end drops (spec-defect / capability-budget).
                       Use only after the root cause is actually fixed.

Default (no --task): resets stuck (crashed in-flight) + recoverable
(blocked-environmental) tasks, leaving dead-ends dropped. Reopens a terminal run
to 'running' when it reset work. Idempotent.

Emits ONE JSON document:
  { run_id, run_status, reset:[...], reopened, skipped:[...] }`;

/**
 * Resolve `runId` from `--run`, falling back to `runs/current` (LOUD if neither is
 * available). Mirrors the run-lifecycle commands' default-to-active-run behavior.
 */
async function resolveRunId(
  state: StateManager,
  args: ReturnType<typeof parseArgs>,
  action: string,
  overrides: CurrentRunOverrides,
): Promise<string> {
  const explicit = args.flag("run");
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const current = await readCurrentForCwd(state, overrides);
  if (current === null) {
    throw new UsageError(`rescue ${action}: no --run given and no current run`);
  }
  return current.run_id;
}

export async function runScan(
  argv: string[],
  overrides: CurrentRunOverrides = {},
): Promise<ExitCode> {
  const args = parseArgs(argv);
  if (args.flag("help") === true) {
    emitLine(SCAN_HELP);
    return EXIT.OK;
  }

  const state = new StateManager();
  const runId = await resolveRunId(state, args, "scan", overrides);
  const run = await state.read(runId);

  // Read-only recoverable-work survey, appended additively. Reuse the same git
  // client resolved for current-run lookup; it runs in the target-repo cwd (where
  // the local `factory/...` branches + `origin/staging-<run-id>` ref live).
  const git = overrides.gitClient ?? new DefaultGitClient();
  const probe: WorkProbe = {
    refExists: (ref) => git.refExists(ref),
    commitsAhead: (base, branch) => git.commitsAhead(base, branch),
  };
  const work = await assessWork(run, probe);

  emitJson({ ...scanRun(run), work });
  return EXIT.OK;
}

export async function runApply(
  argv: string[],
  overrides: CurrentRunOverrides = {},
): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: ["include-dead-ends"] });
  if (args.flag("help") === true) {
    emitLine(APPLY_HELP);
    return EXIT.OK;
  }

  const state = new StateManager();
  const runId = await resolveRunId(state, args, "apply", overrides);
  const tasks = args.all("task");
  const includeDeadEnds = args.flag("include-dead-ends") === true;

  const result = await applyRescue(state, runId, {
    ...(tasks.length > 0 ? { tasks } : {}),
    includeDeadEnds,
  });
  emitJson(result);
  return EXIT.OK;
}

async function run(argv: string[]): Promise<ExitCode> {
  const action = argv[0];
  if (action === undefined || action === "--help" || action === "-h") {
    emitLine(RESCUE_HELP);
    return EXIT.OK;
  }
  const rest = argv.slice(1);
  switch (action) {
    case "scan":
      return runScan(rest);
    case "apply":
      return runApply(rest);
    default:
      throw new UsageError(`unknown rescue action '${action}' (expected scan | apply)`);
  }
}

export const rescueCommand: Subcommand = {
  describe: "Scan or recover a stalled run (reset stuck tasks; reopen a terminal run)",
  run: async (argv) => {
    try {
      return await run(argv);
    } catch (err) {
      if (isUsageError(err)) {
        emitError(`rescue: ${err.message}`);
        return EXIT.USAGE;
      }
      throw err;
    }
  },
};
