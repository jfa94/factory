/**
 * WS9/WS10 — Stop hook: the autonomous-continuation + finalize-on-stop safety net.
 *
 * Ports the PURPOSE of `hooks/stop-gate.sh` onto the NEW state model — NOT a 1:1
 * port. The bash delegated finalize to `pipeline-state finalize-on-stop`; here we
 * use the {@link StateManager} (atomic + locked) and the PURE
 * {@link decideFinalize} so finalize behaviour has the one home WS2 gave it.
 *
 *   1. BLOCK premature stop. While a run is `running` with work still pending
 *      (in-flight tasks, OR setup not finished — no tasks populated yet), the
 *      session must not end: emit `{decision:"block"}` so the in-session
 *      orchestrator keeps driving the stage machine. Escape hatch:
 *      `FACTORY_ALLOW_STOP=1` (emergency recovery / debugging) allows the stop and
 *      leaves the run resumable. (Δ vs bash: dropped the `FACTORY_AUTONOMOUS_MODE`
 *      gate — in the new design the orchestrator IS the session, so a live
 *      `running` run is itself the autonomous signal.)
 *
 *   2. FINALIZE-on-stop. If a `running` run has ≥1 task and EVERY task is terminal
 *      but the run was never explicitly finalized (the session ended right after
 *      the last task), derive the terminal run status ({@link decideFinalize}) and
 *      persist it via {@link StateManager.finalize} — so a completed-but-
 *      unfinalized run never dangles as `running`.
 *
 * Non-`running` statuses pass through untouched: `paused` self-heals in-session,
 * `suspended` is a clean quota exit, and terminal runs are done. A finalize
 * FAILURE blocks the stop (M9 — surface the inconsistency, never silently accept a
 * corrupt-state stop); likewise an unreadable current `state.json` blocks.
 *
 * Output contract (Stop hook): a block is `{decision:"block",reason}` on STDOUT
 * with exit 0 (the JSON is the block signal). Allow = no output, exit 0.
 */
import { EXIT, type ExitCode } from "../cli/exit-codes.js";
import { createLogger } from "../shared/logging.js";
import { StateManager, isTerminalTaskStatus, type RunState } from "../core/state/index.js";
import { decideFinalize } from "../core/stage-machine/engine.js";
import type { DataDirOptions } from "../config/load.js";
import { deny, emitBlockDecision } from "./hook-io.js";

const log = createLogger("hook:stop-gate");

/** The pure stop decision (separated from I/O so it is trivially unit-testable). */
export type StopAction =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "finalize"; status: RunState["status"] };

const ALLOW: StopAction = { kind: "allow" };

/**
 * Decide what to do when the session tries to stop, given a run snapshot and the
 * escape-hatch flag (`FACTORY_ALLOW_STOP===\"1\"`). Pure — no I/O, no state writes.
 */
export function decideStop(run: RunState | null, allowStop: boolean): StopAction {
  if (run === null) return ALLOW; // no active run — nothing to gate.
  if (run.status !== "running") return ALLOW; // terminal / paused / suspended: intentional.

  const tasks = Object.values(run.tasks);
  const nonTerminal = tasks.filter((t) => !isTerminalTaskStatus(t.status));
  // Pending = in-flight tasks OR setup not finished (spec/tasks not yet populated).
  const pending = tasks.length === 0 || nonTerminal.length > 0;

  if (pending) {
    if (allowStop) return ALLOW; // emergency escape — leave the run resumable.
    const detail =
      tasks.length === 0
        ? "spec/tasks not yet populated"
        : `${nonTerminal.length} non-terminal task(s): ` +
          nonTerminal.map((t) => `${t.task_id}=${t.status}`).join(", ");
    return {
      kind: "block",
      reason:
        `run ${run.run_id} is still live (${detail}). Advance the stage machine ` +
        `(\`factory run-task ${run.run_id} <task> --stage <stage>\`) or finalize the run. ` +
        `Set FACTORY_ALLOW_STOP=1 to stop anyway (leaves the run resumable).`,
    };
  }

  // ≥1 task, all terminal, run still `running` → finalize-on-stop.
  return { kind: "finalize", status: decideFinalize(run).run_status };
}

/** Options for {@link runStopGate} (injectable for tests). */
export interface StopGateDeps extends DataDirOptions {
  /** Override the StateManager (tests). */
  manager?: Pick<StateManager, "readCurrent" | "finalize">;
  /** Override the escape-hatch flag (else read from FACTORY_ALLOW_STOP). */
  allowStop?: boolean;
  /** stdout writer (tests capture the block JSON). */
  emit?: (s: string) => void;
}

/**
 * Run the Stop hook end-to-end. A Stop hook reads no stdin we need; it inspects
 * the run store. Always returns {@link EXIT.OK} — the block JSON on stdout (not
 * the exit code) is the signal Claude Code acts on, and a Stop hook must not crash
 * the session with a non-zero exit. Both "block" cases (live run, finalize/read
 * failure) emit `{decision:"block"}`.
 */
export async function runStopGate(
  _argv: string[] = [],
  deps: StopGateDeps = {},
): Promise<ExitCode> {
  const emit = deps.emit ?? ((s: string) => process.stdout.write(s));
  const allowStop = deps.allowStop ?? process.env.FACTORY_ALLOW_STOP === "1";
  const manager = deps.manager ?? new StateManager(deps);

  let run: RunState | null;
  try {
    run = await manager.readCurrent();
  } catch (err) {
    // Corrupt/unreadable current state.json: block so a human notices (the
    // alternative — silently stopping on corrupt state — is the bug Δ M9 fixed).
    const reason =
      `pipeline state unreadable: ${(err as Error).message}. ` +
      `Repair runs/current → state.json (or clear runs/current) before stopping.`;
    log.error(reason);
    emitBlockDecision(deny(reason), emit);
    return EXIT.OK;
  }

  const action = decideStop(run, allowStop);
  switch (action.kind) {
    case "allow":
      return EXIT.OK;
    case "block":
      emitBlockDecision(deny(action.reason), emit);
      return EXIT.OK;
    case "finalize": {
      try {
        await manager.finalize(run!.run_id, action.status);
        log.info(`run ${run!.run_id} finalized as '${action.status}' on stop`);
      } catch (err) {
        const reason =
          `finalize-on-stop failed for ${run!.run_id}: ${(err as Error).message}. ` +
          `Run state may be inconsistent; rerun finalize or investigate before stopping.`;
        log.error(reason);
        emitBlockDecision(deny(reason), emit);
      }
      return EXIT.OK;
    }
  }
}
