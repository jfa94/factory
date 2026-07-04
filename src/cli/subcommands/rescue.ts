/**
 * `factory rescue <scan|apply>` — recover a run that `factory run resume` cannot
 * untangle (Decision 22, Δ S). Resume only clears the quota gate; it never touches
 * task state. When a crashed/suspended session left tasks STUCK mid-phase (so a
 * re-drive would deadlock), rescue is the seam that resets them.
 *
 * Model A: this CLI is a REPORTER (`scan`) + a WRITER (`apply`), never an agent
 * spawner. `scan` emits the pure {@link scanRun} classification — the input the
 * runner (and, for ambiguous failures, the runner-spawned rescue-diagnostic
 * agent) reasons over; the diagnostic then drives `apply --task …`. The CLI provides
 * scan (its input) + apply (the consumer of its decisions); it does NOT run the
 * diagnostic itself.
 */
import { EXIT, type ExitCode } from "../../shared/exit-codes.js";
import { parseArgs, UsageError } from "../args.js";
import { emitJson, emitLine } from "../io.js";
import { StateManager } from "../../core/state/index.js";
import { readCurrentForCwd, type CurrentRunOverrides } from "../current.js";
import { applyRescue } from "../../rescue/index.js";
import { runRecover } from "./recover.js";
import { withUsageGuard, type Subcommand } from "../registry-types.js";

const RESCUE_HELP = `factory rescue — scan or recover a stalled run

Usage:
  factory rescue scan  [--run <id>]
  factory rescue apply [--run <id>] [--task <id>]... [--include-dead-ends] [--reset-e2e] [--recheck-rollup]

Actions:
  scan    Classify every task (read-only); report what a re-drive would do.
  apply   Reset the resettable tasks to pending; reopen a terminal run.`;

const SCAN_HELP = `factory rescue scan — classify a stalled run (read-only)

Usage:
  factory rescue scan [--run <id>]

  --run   The run to scan (defaults to runs/current).

Alias of \`factory recover --dry-run\` (S10). Emits ONE JSON document: the
RescueScan (counts, resettable, dead_ends, needs_rescue, e2e_failed,
rollup_pending, would_deadlock, summary, per-task lines) + the recoverable-work
survey (\`work\`) + the recover \`route\`. Writes nothing.`;

const APPLY_HELP = `factory rescue apply — reset resettable tasks and reopen a terminal run

Usage:
  factory rescue apply [--run <id>] [--task <id>]... [--include-dead-ends] [--reset-e2e] [--recheck-rollup]

  --run                The run to recover (defaults to runs/current).
  --task               Reset exactly this task (repeatable). Overrides the default
                       resettable set; a 'done' task is a loud error, a 'pending'
                       one is skipped. An explicitly-named dead-end IS reset.
  --include-dead-ends  Also reset dead-end failures (spec-defect / capability-budget).
                       Use only after the root cause is actually fixed.
  --reset-e2e          Clear a failed e2e-phase verdict (Decision 39) so it re-enters
                       and re-derives on the next pass; ALSO drops a failed run-start
                       e2e assessment (Decision 40) so it re-fires fresh. Use only
                       once the underlying cause (flaky infra, an app bug, a
                       since-fixed reopen-cap exhaustion) no longer applies. Alone
                       sufficient to reopen a terminal run even when no task itself
                       is resettable.
  --recheck-rollup     Reopen a 'completed' run whose rollup ARMED but never landed
                       (e.g. the "auto-armed" branch-policy fallback) so a re-drive
                       re-enters finalize and picks up the (by-then) merged PR. Use
                       once you've confirmed the queued merge landed. Alone
                       sufficient to reopen a terminal run.

Default (no --task): resets stuck (crashed in-flight) + recoverable
(blocked-environmental) tasks, leaving dead-ends failed. Reopens a terminal run
to 'running' when it reset work (or when --reset-e2e clears a failed e2e phase, or
--recheck-rollup targets an armed-not-landed rollup). Idempotent.

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
  // S10 (Decision 48): scan IS `recover --dry-run` — one envelope, one code path.
  // The recover path additionally reports the chosen `route`, and a missing
  // current run is a routed {kind:"nothing"} answer instead of a usage error.
  return runRecover([...argv, "--dry-run"], overrides);
}

export async function runApply(
  argv: string[],
  overrides: CurrentRunOverrides = {},
): Promise<ExitCode> {
  const args = parseArgs(argv, { booleans: ["include-dead-ends", "reset-e2e", "recheck-rollup"] });
  if (args.flag("help") === true) {
    emitLine(APPLY_HELP);
    return EXIT.OK;
  }

  const state = new StateManager();
  const runId = await resolveRunId(state, args, "apply", overrides);
  const tasks = args.all("task");
  const includeDeadEnds = args.flag("include-dead-ends") === true;
  const resetE2e = args.flag("reset-e2e") === true;
  const recheckRollup = args.flag("recheck-rollup") === true;

  const result = await applyRescue(state, runId, {
    ...(tasks.length > 0 ? { tasks } : {}),
    includeDeadEnds,
    resetE2e,
    recheckRollup,
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
  run: withUsageGuard("rescue", run),
};
