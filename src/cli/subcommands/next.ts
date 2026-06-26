/**
 * `factory next [--run <id>]` — the run-level coroutine: quota gate, checkpoint
 * recovery, cascade-drop, and the ready set. Emits ONE JSON NextEnvelope.
 */
import { EXIT, type ExitCode } from "../../shared/exit-codes.js";
import { parseArgs, isUsageError, UsageError } from "../args.js";
import { emitJson, emitLine, emitError } from "../io.js";
import { loadCoroutineDeps } from "../wiring.js";
import { nextTask } from "../../driver/index.js";
import { StateManager, RunModeEnum } from "../../core/state/index.js";
import type { RunState } from "../../core/state/index.js";
import { resolveDataDir } from "../../config/index.js";
import type { Subcommand } from "../registry-types.js";

const HELP = `factory next — one run-loop step: quota gate, cascade-drop, ready set

Usage:
  factory next [--run <id>]      (defaults to runs/current)

Emits ONE JSON envelope to stdout. Every variant also carries the self-resolved run
context — run_id, data_dir (canonical), ship_mode — so the workflow driver
adopts them from the first \`next\` instead of via Workflow args:
  { kind:"tasks-ready", run_id, data_dir, ship_mode, ready:[...], cascade_dropped:[...] }
  { kind:"all-terminal", run_id, data_dir, ship_mode, cascade_dropped:[...] }  → call \`factory run finalize\`
  { kind:"run-terminal", run_id, data_dir, ship_mode, run_status }
  { kind:"quota-blocked", run_id, data_dir, ship_mode, scope, reason, resets_at_epoch? }

  factory next --assert-owner <session>          (loud-assert runs/current ownership)
  factory next --expect-mode <session|workflow>  (loud-assert runs/current mode)

Ready tasks are ordered in-flight first (crash resume), then pending (spec order).
Throws LOUD on a dependency deadlock.`;

/**
 * Loud-assert that the runs/current run is the one the caller expects, by owning
 * session. The workflow driver's FIRST `next` omits `--run` and adopts
 * runs/current — but `run create` overwrites that pointer (`pointCurrentAt`), so a
 * concurrent create in another session can redirect the workflow onto the WRONG
 * run (Codex CP3 finding); in live mode that opens/merges PRs for a foreign run.
 * When the workflow passes `--assert-owner "$CLAUDE_CODE_SESSION_ID"`, a mismatch
 * against the resolved run's persisted `owner_session` FAILS LOUD here instead of
 * silently driving the foreign run. Degrades safely (no assertion) when either the
 * asserted session or the run's owner is unknown — mirrors the Stop gate's
 * best-effort ownership ({@link RunState.owner_session}).
 *
 * This asserts identity, it does NOT spuriously fire: `CLAUDE_CODE_SESSION_ID` is
 * session-scoped and constant across the agent tree (verified — a sub-agent's Bash
 * sees the SAME value as the launching session), so a Workflow exec-agent's
 * `"$CLAUDE_CODE_SESSION_ID"` equals the orchestrator-stamped `owner_session` on the
 * happy path. A throw means runs/current genuinely points at a foreign run.
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
        `runs/current onto a foreign run. Relaunch via /factory:run --workflow, or ` +
        `pass --run <id> explicitly.`,
    );
  }
}

/**
 * Loud-assert that the runs/current run is in the mode the caller expects. A
 * PROPAGATION-INDEPENDENT companion to {@link assertCurrentOwner}: the workflow
 * driver passes `--expect-mode workflow`, so a concurrent `run create` that
 * redirected runs/current onto a run of a DIFFERENT mode (e.g. a session-mode run)
 * fails loud here regardless of session-id behavior. Necessary-not-sufficient (two
 * concurrent workflow-mode creates still need the owner assertion above), but it
 * closes the most likely foreign-run window with zero env assumptions. Absent flag ⇒
 * no expectation; an invalid value is a loud usage error.
 */
function assertExpectedMode(current: RunState, expectMode: string | boolean | undefined): void {
  if (expectMode === undefined) return; // no expectation requested
  const parsed = RunModeEnum.safeParse(typeof expectMode === "string" ? expectMode : "");
  if (!parsed.success) {
    throw new UsageError(
      `--expect-mode must be ${RunModeEnum.options.map((o) => `'${o}'`).join(" or ")}, ` +
        `got '${String(expectMode)}'`,
    );
  }
  if (current.mode !== parsed.data) {
    throw new Error(
      `next: runs/current points at run '${current.run_id}' in mode '${current.mode}', but ` +
        `--expect-mode expected '${parsed.data}' — a concurrent 'run create' moved runs/current ` +
        `onto a run of a different mode. Relaunch via /factory:run --workflow, or pass ` +
        `--run <id> explicitly.`,
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
    assertExpectedMode(current, args.flag("expect-mode"));
    runId = current.run_id;
  }

  const deps = await loadCoroutineDeps({ runId });
  emitJson(await nextTask(deps, runId));
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
