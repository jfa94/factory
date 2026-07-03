/**
 * `factory next-task [--run <id>]` — the run-level orchestrator: quota gate, checkpoint
 * recovery, cascade-fail, and the ready set. Emits ONE JSON NextTask.
 */
import { EXIT, type ExitCode } from "../../shared/exit-codes.js";
import { parseArgs, UsageError } from "../args.js";
import { emitJson, emitLine } from "../io.js";
import { loadOrchestratorDeps } from "../wiring.js";
import { nextTask } from "../../orchestrator/index.js";
import { StateManager } from "../../core/state/index.js";
import type { RunState } from "../../core/state/index.js";
import { resolveDataDir } from "../../config/index.js";
import { withUsageGuard, type Subcommand } from "../registry-types.js";

const HELP = `factory next-task — one run-loop step: quota gate, cascade-fail, ready set

Usage:
  factory next-task [--run <id>]      (defaults to runs/current)

Emits ONE JSON envelope to stdout. Every variant also carries the self-resolved run
context — run_id, data_dir (canonical), ship_mode — so the runner adopts them
from the first \`next-task\`:
  { kind:"work", run_id, data_dir, ship_mode, ready:[...], cascade_failed:[...], max_parallel }
  { kind:"finalize", run_id, data_dir, ship_mode, cascade_failed:[...] }  → call \`factory run finalize\`
  { kind:"done", run_id, data_dir, ship_mode, run_status }
  { kind:"pause", run_id, data_dir, ship_mode, scope, reason, resets_at_epoch? }

  factory next-task --assert-owner <session>          (loud-assert runs/current ownership)

Ready tasks are ordered in-flight first (crash resume), then pending (spec order).
Throws LOUD on a dependency deadlock.`;

/**
 * Loud-assert that the runs/current run is the one the caller expects, by owning
 * session. The runner's FIRST `next-task` omits `--run` and adopts
 * runs/current — but `run create` overwrites that pointer (`pointCurrentAt`), so a
 * concurrent create in another session can redirect the runner onto the WRONG
 * run (Codex CP3 finding); in live mode that opens/merges PRs for a foreign run.
 * When the runner passes `--assert-owner "$CLAUDE_CODE_SESSION_ID"`, a mismatch
 * against the resolved run's persisted `owner_session` FAILS LOUD here instead of
 * silently driving the foreign run. Degrades safely (no assertion) when either the
 * asserted session or the run's owner is unknown — mirrors the Stop gate's
 * best-effort ownership ({@link RunState.owner_session}).
 *
 * This asserts identity, it does NOT spuriously fire: `CLAUDE_CODE_SESSION_ID` is
 * session-scoped and constant across the agent tree (verified — a sub-agent's Bash
 * sees the SAME value as the launching session), so an agent's
 * `"$CLAUDE_CODE_SESSION_ID"` equals the runner-stamped `owner_session` on the
 * happy path. A throw means runs/current genuinely points at a foreign run.
 */
function assertCurrentOwner(current: RunState, assertOwner: string | boolean | undefined): void {
  const expected = typeof assertOwner === "string" ? assertOwner.trim() : "";
  if (expected.length === 0) return; // no assertion requested / session env unset
  const actual = current.owner_session;
  if (actual === undefined) return; // run owner unknown → cannot assert (degrade safe)
  if (actual !== expected) {
    throw new Error(
      `next-task: runs/current points at run '${current.run_id}' owned by session '${actual}', ` +
        `but --assert-owner expected '${expected}' — a concurrent 'run create' moved ` +
        `runs/current onto a foreign run. Pass --run <id> explicitly.`,
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

  const deps = await loadOrchestratorDeps({ runId });
  emitJson(await nextTask(deps, runId));
  return EXIT.OK;
}

export const nextCommand: Subcommand = {
  describe: "One run-loop step: quota gate, cascade-fail, emit the ready set",
  run: withUsageGuard("next-task", run),
};
