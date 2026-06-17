/**
 * `factory next [--run <id>]` — the run-level coroutine: quota gate, checkpoint
 * recovery, cascade-drop, and the ready set. Emits ONE JSON NextEnvelope.
 */
import { EXIT, type ExitCode } from "../exit-codes.js";
import { parseArgs, isUsageError, UsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { loadCoroutineDeps } from "../wiring.js";
import { stepRun } from "../../driver/index.js";
import { StateManager } from "../../core/state/index.js";
import type { RunState } from "../../core/state/index.js";
import { resolveDataDir } from "../../config/index.js";
import type { Subcommand } from "../main.js";

const HELP = `factory next — one run-loop step: quota gate, cascade-drop, ready set

Usage:
  factory next [--run <id>]      (defaults to runs/current)

Emits ONE JSON envelope to stdout. Every variant also carries the self-resolved run
context — run_id, data_dir (canonical), ship_mode — so the --mode workflow driver
adopts them from the first \`next\` instead of via Workflow args:
  { kind:"tasks-ready", run_id, data_dir, ship_mode, ready:[...], cascade_dropped:[...] }
  { kind:"all-terminal", run_id, data_dir, ship_mode, cascade_dropped:[...] }  → call \`factory run finalize\`
  { kind:"run-terminal", run_id, data_dir, ship_mode, run_status }
  { kind:"quota-blocked", run_id, data_dir, ship_mode, scope, reason, resets_at_epoch? }

  factory next --assert-owner <session>   (loud-assert runs/current ownership)

Ready tasks are ordered in-flight first (crash resume), then pending (spec order).
Throws LOUD on a dependency deadlock.`;

/**
 * Loud-assert that the runs/current run is the one the caller expects, by owning
 * session. The `--mode workflow` driver's FIRST `next` omits `--run` and adopts
 * runs/current — but `run create` overwrites that pointer (`pointCurrentAt`), so a
 * concurrent create in another session can redirect the workflow onto the WRONG
 * run (Codex CP3 finding); in live mode that opens/merges PRs for a foreign run.
 * When the workflow passes `--assert-owner "$CLAUDE_CODE_SESSION_ID"`, a mismatch
 * against the resolved run's persisted `owner_session` FAILS LOUD here instead of
 * silently driving the foreign run. Degrades safely (no assertion) when either the
 * asserted session or the run's owner is unknown — mirrors the Stop gate's
 * best-effort ownership ({@link RunState.owner_session}).
 */
function assertCurrentOwner(current: RunState, assertOwner: string | boolean | undefined): void {
  const expected = typeof assertOwner === "string" ? assertOwner.trim() : "";
  if (expected.length === 0) return; // no assertion requested / session env unset
  const actual = current.owner_session;
  if (actual === undefined) return; // run owner unknown → cannot assert (degrade safe)
  if (actual !== expected) {
    throw new Error(
      `next: runs/current points at run '${current.run_id}' owned by session '${actual}', ` +
        `but --assert-owner expected '${expected}' — a concurrent 'run create' moved ` +
        `runs/current onto a foreign run. Relaunch via /factory:run --mode workflow, or ` +
        `pass --run <id> explicitly.`,
    );
  }
}

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
    if (current === null) throw new UsageError("no --run given and no current run");
    assertCurrentOwner(current, args.flag("assert-owner"));
    runId = current.run_id;
  }

  const deps = await loadCoroutineDeps({ runId });
  emitJson(await stepRun(deps, runId));
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
