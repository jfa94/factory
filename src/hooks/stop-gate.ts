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
 *      OWNING session must not end: emit `{decision:"block"}` so the in-session
 *      orchestrator keeps driving the stage machine. Escape hatch:
 *      `FACTORY_ALLOW_STOP=1` (emergency recovery / debugging) allows the stop and
 *      leaves the run resumable. (Δ vs bash: dropped the `FACTORY_AUTONOMOUS_MODE`
 *      gate.)
 *
 *      SESSION-SCOPED + MODE-AWARE (Prompt J — fixes two false-blocks):
 *        (a) MODE — in `mode === "workflow"` the interactive session is NOT the
 *            driver: a background Workflow owns continuation AND finalize-on-stop, so
 *            the session passes through (blocking it + telling the user to hand-run
 *            `factory next`/`drive` would be actively wrong).
 *        (b) OWNERSHIP — when the run carries an `owner_session` (stamped at
 *            `run create`) and the STOPPING session id (read from the Stop hook's
 *            stdin `session_id`) is a DIFFERENT session, that session is unrelated to
 *            this run and passes through. Only the actual owner is gated. When the
 *            owner is UNKNOWN (couldn't be stamped) OR the stopping session is unknown
 *            (no stdin), we fall back to the unscoped block (degraded but safe — never
 *            let the real owner stop silently with pending work).
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
import { deny, emitBlockDecision, parseHookInput, readStdin } from "./hook-io.js";

const log = createLogger("hook:stop-gate");

/** The pure stop decision (separated from I/O so it is trivially unit-testable). */
export type StopAction =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "finalize"; status: RunState["status"] };

const ALLOW: StopAction = { kind: "allow" };

/**
 * Decide what to do when the session tries to stop, given a run snapshot, the
 * escape-hatch flag (`FACTORY_ALLOW_STOP===\"1\"`), and the id of the STOPPING
 * session (from the Stop hook stdin; `undefined` when it could not be read). Pure —
 * no I/O, no state writes.
 *
 * Precedence (each earlier rule short-circuits):
 *   1. no active run / not `running`               → allow (unchanged).
 *   2. `mode === "workflow"`                        → allow (prong a: the Workflow,
 *      not the session, drives continuation + finalize-on-stop).
 *   3. owner KNOWN and stopping session ≠ owner     → allow (prong b: an unrelated
 *      session must not be blocked by another session's run).
 *   4. otherwise (the owner, or an unknown owner/stopping session — degraded-safe)
 *      → the existing pending/block + all-terminal/finalize logic (unchanged).
 */
export function decideStop(
  run: RunState | null,
  allowStop: boolean,
  stoppingSession?: string,
): StopAction {
  if (run === null) return ALLOW; // no active run — nothing to gate.
  if (run.status !== "running") return ALLOW; // terminal / paused / suspended: intentional.

  // (a) MODE-AWARENESS — workflow mode: the background Workflow owns continuation +
  // finalize-on-stop, so the interactive session is never the driver here. Pass
  // through (the Stop hook must not block it, nor finalize on its behalf).
  if (run.mode === "workflow") return ALLOW;

  // (b) SESSION-OWNERSHIP — when the owning session is KNOWN and a DIFFERENT session
  // is stopping, that session is unrelated to this run: pass through. An unknown
  // owner, or an unknown stopping session, falls through to the unscoped block below
  // (degraded but safe — we cannot prove the stopper is NOT the owner).
  if (
    run.owner_session !== undefined &&
    stoppingSession !== undefined &&
    stoppingSession !== run.owner_session
  ) {
    return ALLOW;
  }

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
        `run ${run.run_id} is still live (${detail}). Advance the run ` +
        `(\`factory next --run ${run.run_id}\`, then \`factory drive --run ${run.run_id} --task <task>\`) or finalize it. ` +
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
  /** Read the raw Stop-hook stdin (tests inject; prod reads process.stdin). */
  readRaw?: () => Promise<string>;
}

/**
 * Run the Stop hook end-to-end. Reads the Stop event stdin to extract the STOPPING
 * session id (`session_id`) so the gate can session-scope its block (Prompt J), then
 * inspects the run store. Always returns {@link EXIT.OK} — the block JSON on stdout
 * (not the exit code) is the signal Claude Code acts on, and a Stop hook must not
 * crash the session with a non-zero exit. Both "block" cases (live run, finalize/read
 * failure) emit `{decision:"block"}`. A malformed/empty stdin yields an UNKNOWN
 * stopping session (degraded-safe: the gate then keeps the unscoped block).
 */
export async function runStopGate(
  _argv: string[] = [],
  deps: StopGateDeps = {},
): Promise<ExitCode> {
  const emit = deps.emit ?? ((s: string) => process.stdout.write(s));
  const allowStop = deps.allowStop ?? process.env.FACTORY_ALLOW_STOP === "1";
  const manager = deps.manager ?? new StateManager(deps);

  // Resolve the stopping session id from the Stop event stdin (best-effort: a
  // malformed/empty/absent payload leaves it undefined → the gate stays unscoped).
  let stoppingSession: string | undefined;
  try {
    const raw = deps.readRaw ? await deps.readRaw() : await readStdin();
    const input = parseHookInput(raw);
    stoppingSession =
      typeof input?.session_id === "string" && input.session_id.length > 0
        ? input.session_id
        : undefined;
  } catch (err) {
    // A corrupt stdin is non-fatal here — we just lose session-scoping (degraded but
    // safe: the owner-or-unknown block still applies). Never block the stop on this.
    log.warn(`Stop hook stdin unparseable (session-scoping skipped): ${(err as Error).message}`);
    stoppingSession = undefined;
  }

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

  const action = decideStop(run, allowStop, stoppingSession);
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
