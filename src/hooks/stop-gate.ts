/**
 * WS9/WS10 — Stop hook: the finalize-on-stop safety net.
 *
 * Ports the PURPOSE of `hooks/stop-gate.sh` onto the NEW state model — NOT a 1:1
 * port. The bash delegated finalize to `pipeline-state finalize-on-stop`; here we
 * use the {@link StateManager} (atomic + locked) and the PURE
 * {@link decideFinalize} so finalize behaviour has the one home WS2 gave it.
 *
 * The hook NO LONGER blocks a premature stop. A live run with pending work used to
 * emit `{decision:"block"}` to force the in-session orchestrator to keep driving —
 * the "session-hostage" behaviour that trapped a session which could not progress.
 * That arm (and its `FACTORY_ALLOW_STOP` escape hatch) is removed: a session may
 * always stop, and a run left `running` with pending work stays cleanly resumable via
 * `factory resume`. Re-entry is idempotent even when the stop landed mid-spawn: the
 * coroutine records a `spawn_in_flight` checkpoint at every spawn emit, so a resume that
 * re-enters the same (phase, rung) before results were recorded resets the task worktree to
 * the captured pre-spawn tip — discarding the abandoned producer's partial work — before
 * re-spawning (see `coroutine.ts` spawn-agents case + `applyResume`).
 *
 *   FINALIZE-on-stop. If a session-mode `running` run has ≥1 task and EVERY task is
 *   terminal but the run was never explicitly finalized (the session ended right after
 *   the last task), derive the terminal run status ({@link decideFinalize}) and persist
 *   it via {@link StateManager.finalize} — so a completed-but-unfinalized run never
 *   dangles as `running`. This is the ONLY state mutation the hook performs.
 *
 *   SESSION-SCOPED + MODE-AWARE (Prompt J — so the hook finalizes the RIGHT run, and
 *   only its own):
 *     (a) MODE — in `mode === "workflow"` the interactive session is NOT the driver: a
 *         background Workflow owns continuation AND finalize-on-stop, so the session
 *         passes through (finalizing on its behalf could race the Workflow).
 *     (b) OWNERSHIP — when the run carries an `owner_session` (stamped at `run create`)
 *         and the STOPPING session id (read from the Stop hook's stdin `session_id`) is
 *         a DIFFERENT session, that run is unrelated to this session and passes through
 *         — a session never finalizes another session's run.
 *
 * Non-`running` statuses pass through untouched: `paused` self-heals in-session,
 * `suspended` is a clean quota exit, and terminal runs are done. A finalize FAILURE
 * blocks the stop (M9 — surface the inconsistency, never silently accept a corrupt-state
 * stop); likewise an inaccessible data directory blocks. These two are the hook's ONLY
 * remaining blocks, both local filesystem errors — a foreign run's unreadable state.json
 * never surfaces here (listRuns skips unreadable runs silently).
 *
 * Output contract (Stop hook): a block (corruption only) is `{decision:"block",reason}`
 * on STDOUT with exit 0 (the JSON is the block signal). Allow = no output, exit 0.
 */
import { EXIT, type ExitCode } from "../shared/exit-codes.js";
import { createLogger } from "../shared/logging.js";
import {
  StateManager,
  isTerminalTaskStatus,
  TERMINAL_RUN_STATUSES,
  type RunState,
} from "../core/state/index.js";
import { decideFinalize } from "../core/phase-machine/engine.js";
import type { DataDirOptions } from "../config/load.js";
import { deny, emitBlockDecision, parseHookInput, readStdin, sessionIdOf } from "./hook-io.js";

const log = createLogger("hook:stop-gate");

/**
 * The pure stop decision (separated from I/O so it is trivially unit-testable). With
 * the pending-work block removed, the hook only ever ALLOWS or FINALIZES; the two
 * remaining corruption blocks (inaccessible data directory, finalize failure) are emitted
 * directly by {@link runStopGate}, not modelled here.
 */
export type StopAction =
  | { kind: "allow" }
  // `finalize` is terminal-by-construction: the producer is `decideFinalize`
  // (returns completed|failed — whole-PRD delivery, Decision 34) and `manager.finalize`
  // rejects any non-terminal status — so the type matches reality, not the full RunStatus union.
  | { kind: "finalize"; status: (typeof TERMINAL_RUN_STATUSES)[number] };

const ALLOW: StopAction = { kind: "allow" };

/**
 * Decide what to do when the session tries to stop, given a run snapshot and the id of
 * the STOPPING session (from the Stop hook stdin; `undefined` when it could not be read).
 * Pure — no I/O, no state writes. Returns `allow` in EVERY case except an owned,
 * session-mode, all-terminal run, which finalizes-on-stop.
 *
 * Precedence (each earlier rule short-circuits to `allow`):
 *   1. no active run / not `running`            → allow.
 *   2. `mode === "workflow"`                     → allow (the Workflow, not the session,
 *      drives continuation + finalize-on-stop).
 *   3. owner KNOWN and stopping session ≠ owner  → allow (a session never finalizes
 *      another session's run).
 *   4. pending work (in-flight tasks, or setup unfinished) → allow (NO hostage: the run
 *      stays `running` and resumable via `factory resume`).
 *   5. otherwise (≥1 task, all terminal)         → finalize-on-stop.
 */
export function decideStop(run: RunState | null, stoppingSession?: string): StopAction {
  if (run === null) return ALLOW; // no active run — nothing to gate.
  if (run.status !== "running") return ALLOW; // terminal / paused / suspended: intentional.

  // (a) MODE-AWARENESS — workflow mode: the background Workflow owns continuation +
  // finalize-on-stop, so the interactive session is never the driver here. Pass through
  // (finalizing on its behalf could race the Workflow's own finalization).
  if (run.mode === "workflow") return ALLOW;

  // (b) SESSION-OWNERSHIP — when the owning session is KNOWN and a DIFFERENT session is
  // stopping, that run is unrelated to this session: pass through.
  // (Session-mode run create now requires an owner, so un-owned session-mode runs don't
  // arise in normal operation. In workflow mode this check is irrelevant — workflow is
  // already returned above. The guard is belt-and-suspenders for unusual paths.)
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

  // Pending work NO LONGER blocks the stop (the session-hostage fix). The session may
  // end; the run stays `running` and is resumed idempotently by `factory resume`.
  if (pending) return ALLOW;

  // ≥1 task, all terminal, run still `running` → finalize-on-stop.
  return { kind: "finalize", status: decideFinalize(run).run_status };
}

/** Options for {@link runStopGate} (injectable for tests). */
export interface StopGateDeps extends DataDirOptions {
  /** Override the StateManager (tests). */
  manager?: Pick<StateManager, "finalize" | "findActiveByOwner">;
  /** stdout writer (tests capture the block JSON). */
  emit?: (s: string) => void;
  /** Read the raw Stop-hook stdin (tests inject; prod reads process.stdin). */
  readRaw?: () => Promise<string>;
}

/**
 * Run the Stop hook end-to-end. Reads the Stop event stdin to extract the STOPPING
 * session id (`session_id`) so the gate can session-scope its finalize. Resolves only
 * the run the stopping session OWNS via {@link StateManager.findActiveByOwner} — never
 * the global `runs/current` pointer. Always returns {@link EXIT.OK} — the block JSON on
 * stdout (not the exit code) is the signal Claude Code acts on, and a Stop hook must not
 * crash the session with a non-zero exit. The ONLY blocks are the two corruption cases
 * (data-dir unreadable, finalize failure); a live run with pending work or an unknown
 * stopping session passes through.
 */
export async function runStopGate(
  _argv: string[] = [],
  deps: StopGateDeps = {},
): Promise<ExitCode> {
  const emit = deps.emit ?? ((s: string) => process.stdout.write(s));
  const manager = deps.manager ?? new StateManager(deps);

  // Resolve the stopping session id from the Stop event stdin (best-effort: a
  // malformed/empty/absent payload leaves it undefined → the gate stays unscoped).
  let stoppingSession: string | undefined;
  try {
    const raw = deps.readRaw ? await deps.readRaw() : await readStdin();
    stoppingSession = sessionIdOf(parseHookInput(raw));
  } catch (err) {
    // A corrupt stdin is non-fatal here — we just lose session-scoping (degraded:
    // unknown stopper → null → allow). Never block the stop on this.
    log.error(`Stop hook stdin unparseable (session-scoping skipped): ${(err as Error).message}`);
    stoppingSession = undefined;
  }

  let run: RunState | null;
  try {
    run = stoppingSession !== undefined ? await manager.findActiveByOwner(stoppingSession) : null;
    if (run === null && stoppingSession !== undefined) {
      // No single owned run found: either no active run, or session owns ≥2 (ambiguous).
      // Either way, nothing to finalize — allow the stop.
      log.warn(
        `Stop: session '${stoppingSession}' has no single attributed active run; passing through.`,
      );
    }
  } catch (err) {
    // A failure here means our own data directory is inaccessible (listRuns → readdir
    // failed with a non-ENOENT error). Foreign runs' unreadable state.json files are
    // silently skipped by listRuns — they never surface here.
    const rawMsg = (err as Error).message.replace(/[\x00-\x1f]/g, " ").slice(0, 200);
    const reason =
      `could not enumerate run state: ${rawMsg}. ` +
      `Investigate the factory data directory before stopping.`;
    log.error(reason);
    emitBlockDecision(deny(reason), emit);
    return EXIT.OK;
  }

  const action = decideStop(run, stoppingSession);
  switch (action.kind) {
    case "allow":
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
