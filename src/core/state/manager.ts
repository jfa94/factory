/**
 * WS1 — StateManager: the only sanctioned way to read/mutate run state.
 *
 * Contract (plan §"Mechanics"):
 *   - WRITES are atomic + durable (temp + fsync + rename + fsync-parent) via
 *     src/shared/atomicWriteFile, and serialized by a ROBUST lock
 *     (proper-lockfile) held for the whole read-modify-write cycle. This replaces
 *     the bash flock-10s-with-mkdir-fallback that could fail under contention.
 *   - READS are lock-free (a consistent snapshot is guaranteed by the atomic
 *     rename on the writer side — a reader sees either the old or the new file,
 *     never a torn write).
 *   - Lifecycle: create → read → update → finalize.
 *   - Gate verdicts are DERIVED, never stored (derive.ts); this class exposes no
 *     setter for a gate boolean.
 *
 * Lock design notes:
 *   - We lock a per-run lockfile under the run dir, using `realpath: false` so the
 *     lock can be acquired even while `state.json` is mid-rename and around
 *     `create` (the run dir is mkdir'd first). The lockfile is a dedicated path,
 *     not state.json itself, so the atomic rename never disturbs the lock.
 *   - `stale` + `retries` make the lock self-heal from a crashed holder and wait
 *     out a live holder instead of failing fast (the bash 10s hard-fail was the
 *     weak point WS1 is told to harden).
 *   - `onCompromised` THROWS (the proper-lockfile default) — a compromised lock is
 *     loud, never silently ignored.
 */
import { mkdir, readFile, rename, rm, symlink, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { lock } from "proper-lockfile";
import { atomicWriteFile } from "../../shared/atomic-write.js";
import { parseJson, stringifyJson } from "../../shared/json.js";
import { nowIso } from "../../shared/time.js";
import { createLogger } from "../../shared/logging.js";
import { resolveDataDir, type DataDirOptions } from "../../config/load.js";
import { currentLinkPath, runDir, runStatePath, RUNS_DIR } from "./paths.js";
import {
  parseRunState,
  type RunState,
  type SpecPointer,
  type TaskState,
  isTerminalRunStatus,
} from "./schema.js";

const log = createLogger("state");

/** Tunables for the robust lock. Defaults harden past the bash 10s hard-fail. */
export interface LockTuning {
  /** Ms after which a held lock is considered stale (crashed holder). */
  stale: number;
  /** Total retry attempts to acquire a contended lock before giving up. */
  retries: number;
  /** Base backoff (ms) between retries (exponential, capped). */
  retryMinTimeout: number;
  /** Max backoff (ms) between retries. */
  retryMaxTimeout: number;
}

const DEFAULT_LOCK_TUNING: LockTuning = {
  stale: 15_000,
  // Enough attempts that ≥3 concurrent writers all eventually win their turn.
  retries: 50,
  retryMinTimeout: 20,
  retryMaxTimeout: 500,
};

export interface StateManagerOptions extends DataDirOptions {
  /** Override lock tuning (tests use a tighter window). */
  lock?: Partial<LockTuning>;
}

/** Arguments to {@link StateManager.create}. */
export interface CreateRunArgs {
  run_id: string;
  spec: SpecPointer;
  driver?: RunState["driver"];
}

export class StateManager {
  readonly dataDir: string;
  private readonly lockTuning: LockTuning;

  constructor(opts: StateManagerOptions = {}) {
    this.dataDir = resolveDataDir(opts);
    this.lockTuning = { ...DEFAULT_LOCK_TUNING, ...(opts.lock ?? {}) };
  }

  // ---- paths -------------------------------------------------------------

  private statePath(runId: string): string {
    return runStatePath(this.dataDir, runId);
  }

  private lockfilePath(runId: string): string {
    // Dedicated lockfile under the run dir; NOT state.json (so the atomic
    // rename of state.json never collides with the lock).
    return join(runDir(this.dataDir, runId), "state.lock");
  }

  // ---- lock --------------------------------------------------------------

  /**
   * Run `fn` while holding the per-run lock. The lockfile's parent (the run dir)
   * must already exist — `create` mkdirs it before first lock; mutators lock an
   * existing run. `realpath:false` lets us lock a path whose target may be
   * mid-rename.
   */
  private async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const dir = runDir(this.dataDir, runId);
    if (!existsSync(dir)) {
      throw new Error(`state: cannot lock run '${runId}' — run dir does not exist`);
    }
    const release = await lock(this.lockfilePath(runId), {
      realpath: false,
      stale: this.lockTuning.stale,
      retries: {
        retries: this.lockTuning.retries,
        minTimeout: this.lockTuning.retryMinTimeout,
        maxTimeout: this.lockTuning.retryMaxTimeout,
        factor: 1.5,
      },
      onCompromised: (err) => {
        // Loud, never silent. Re-throw per proper-lockfile's contract.
        log.error(`state lock for run '${runId}' was compromised: ${err.message}`);
        throw err;
      },
    });
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  // ---- create ------------------------------------------------------------

  /**
   * Create a brand-new run. Mkdirs the run store layout, writes the initial
   * state.json atomically under the lock, and (best-effort) points `runs/current`
   * at it. Refuses to clobber an existing run dir.
   */
  async create(args: CreateRunArgs): Promise<RunState> {
    const dir = runDir(this.dataDir, args.run_id);
    // Cheap fast-path guard — NOT authoritative on its own (racy). The binding
    // clobber check is re-run INSIDE the lock below so two concurrent create()
    // calls for the same run_id cannot both pass it (TOCTOU).
    if (existsSync(this.statePath(args.run_id))) {
      throw new Error(`state: run '${args.run_id}' already exists`);
    }
    // The lockfile's parent (the run dir) must exist before we can lock it.
    await mkdir(join(dir, "holdouts"), { recursive: true });
    await mkdir(join(dir, "reviews"), { recursive: true });

    const now = nowIso();
    const state = parseRunState({
      run_id: args.run_id,
      status: "running",
      driver: args.driver ?? "balanced",
      spec: args.spec,
      tasks: {},
      started_at: now,
      updated_at: now,
      ended_at: null,
    });

    await this.withLock(args.run_id, async () => {
      // AUTHORITATIVE clobber guard: re-check inside the critical section so the
      // loser of a same-id create() race throws here instead of overwriting the
      // winner's state.json (last-writer-wins). Exactly one create() wins.
      if (existsSync(this.statePath(args.run_id))) {
        throw new Error(`state: run '${args.run_id}' already exists`);
      }
      await atomicWriteFile(this.statePath(args.run_id), stringifyJson(state));
    });

    // Touch the append-only logs so downstream appenders need no existence check.
    await atomicWriteFile(join(dir, "audit.jsonl"), "");
    await atomicWriteFile(join(dir, "metrics.jsonl"), "");

    await this.pointCurrentAt(args.run_id);
    return state;
  }

  // ---- read (lock-free) --------------------------------------------------

  /**
   * Read + validate a run's state. LOCK-FREE: the atomic rename on the writer
   * side guarantees a reader sees a whole file. LOUD on a missing run or a
   * schema/JSON violation (never a silent partial).
   */
  async read(runId: string): Promise<RunState> {
    const path = this.statePath(runId);
    const raw = await readFile(path, "utf8");
    return parseRunState(parseJson<unknown>(raw, path));
  }

  /**
   * Read the run currently pointed at by `runs/current`, or null if there is no
   * current run. `current` is a directory symlink; we read `state.json` *through*
   * it (the OS follows the symlink during the path walk), so no separate readlink
   * is needed. LOUD on a corrupt/invalid current state.json — only genuine
   * ABSENCE (missing/dangling symlink → ENOENT) maps to null, matching read()'s
   * loud-on-corruption contract. Swallowing a ZodError/JSON error here would make
   * a corrupt active run indistinguishable from "no current run".
   */
  async readCurrent(): Promise<RunState | null> {
    const link = currentLinkPath(this.dataDir);
    if (!existsSync(link)) return null;
    const statePath = join(link, "state.json");
    let raw: string;
    try {
      raw = await readFile(statePath, "utf8");
    } catch (err) {
      // Absence (no/dangling current symlink) is the only swallowed case.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    // Parse/schema errors propagate loudly (corruption is never silent).
    return parseRunState(parseJson<unknown>(raw, statePath));
  }

  // ---- update (locked read-modify-write) ---------------------------------

  /**
   * Atomically mutate a run under the lock. `mutator` receives the current state
   * and returns the next state; the result is re-validated through the schema
   * (so a mutator cannot persist an out-of-enum value) and `updated_at` is
   * stamped. This is the ONLY write path for an existing run.
   */
  async update(
    runId: string,
    mutator: (state: RunState) => RunState | Promise<RunState>,
  ): Promise<RunState> {
    return this.withLock(runId, async () => {
      const current = await this.read(runId);
      const next = await mutator(current);
      // Identity is the storage key: run_id keys the directory and (repo, spec_id)
      // is the durable spec address. A mutator that changes either would persist a
      // state.json whose identity disagrees with its path, silently breaking
      // addressability. Pin both — a mutator must never rewrite identity.
      if (next.run_id !== runId) {
        throw new Error(
          `state: update mutator changed run_id ('${runId}' → '${next.run_id}') — identity is immutable`,
        );
      }
      if (
        next.spec.repo !== current.spec.repo ||
        next.spec.spec_id !== current.spec.spec_id ||
        next.spec.issue_number !== current.spec.issue_number
      ) {
        throw new Error(
          `state: update mutator changed the spec pointer for run '${runId}' — identity is immutable`,
        );
      }
      const validated = parseRunState({ ...next, updated_at: nowIso() });
      await atomicWriteFile(this.statePath(runId), stringifyJson(validated));
      return validated;
    });
  }

  /**
   * Convenience: mutate a single task in place. Throws if the task is absent
   * (a typo'd task id is a loud error, not a silent create).
   */
  async updateTask(
    runId: string,
    taskId: string,
    mutator: (task: TaskState) => TaskState,
  ): Promise<RunState> {
    return this.update(runId, (state) => {
      const task = state.tasks[taskId];
      if (!task) {
        throw new Error(`state: run '${runId}' has no task '${taskId}'`);
      }
      return { ...state, tasks: { ...state.tasks, [taskId]: mutator(task) } };
    });
  }

  // ---- finalize ----------------------------------------------------------

  /**
   * Finalize a run to a TERMINAL status (Decision 22/24 — finalize is terminal,
   * never spins). Refuses a non-terminal status. Stamps `ended_at`. Idempotent
   * for the same terminal status.
   */
  async finalize(runId: string, status: RunState["status"]): Promise<RunState> {
    if (!isTerminalRunStatus(status)) {
      throw new Error(
        `state: finalize requires a terminal status (completed|partial|failed); got '${status}'`,
      );
    }
    return this.update(runId, (state) => {
      if (isTerminalRunStatus(state.status) && state.status !== status) {
        throw new Error(
          `state: run '${runId}' already terminal as '${state.status}'; cannot re-finalize as '${status}'`,
        );
      }
      // Clear any quota checkpoint: it is valid ONLY while paused|suspended
      // (refineRunCrossFields), so a paused/suspended run that finalizes to a
      // terminal status must drop it or re-validation throws. Finalize is
      // terminal — there is no resume horizon to preserve.
      return { ...state, status, quota: undefined, ended_at: state.ended_at ?? nowIso() };
    });
  }

  // ---- current symlink ---------------------------------------------------

  /**
   * Point `runs/current` at the given run (best-effort, atomic-ish: write a temp
   * link then rename). A failure here is logged, not fatal — `current` is a
   * convenience pointer, not load-bearing state.
   */
  private async pointCurrentAt(runId: string): Promise<void> {
    const link = currentLinkPath(this.dataDir);
    const tmp = `${link}.tmp.${process.pid}`;
    try {
      await mkdir(dirname(link), { recursive: true });
      await unlink(tmp).catch(() => {});
      // Relative target so the data dir is relocatable.
      await symlink(join(runId), tmp);
      await rm(link, { force: true, recursive: false }).catch(() => {});
      await rename(tmp, link);
    } catch (err) {
      log.warn(`state: could not update runs/current to '${runId}': ${(err as Error).message}`);
      await unlink(tmp).catch(() => {});
    }
  }
}

/** Re-export the store subdir name for callers that enumerate runs. */
export { RUNS_DIR };
