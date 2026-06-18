/**
 * `withFileLock` — the single cross-process file-lock primitive.
 *
 * The ONLY `proper-lockfile` import site in the engine. Both serial writers ride
 * it: WS1's StateManager (per-run + per-spec read-modify-write) and WS3's
 * MergeSerializer (one squash-merge into staging at a time). Cross-process
 * writers — concurrent `factory drive` processes in `--mode workflow` — can't be
 * serialized by an in-memory mutex, so a robust file lock is the floor, not
 * gold-plating.
 *
 * Design notes (preserved from the two call sites this replaces):
 *   - `realpath:false` lets us lock a path whose target may be mid-rename or not
 *     yet exist (proper-lockfile creates a sibling `<path>.lock`). The lockfile is
 *     a dedicated path, never the data file, so an atomic rename never disturbs it.
 *   - `stale` + `retries` make the lock self-heal from a crashed holder and wait
 *     out a live holder instead of failing fast (hardens past the old bash
 *     flock-10s hard-fail).
 *   - `onCompromised` THROWS (proper-lockfile's contract) — a compromised lock is
 *     loud, never silently ignored.
 */
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { lock } from "proper-lockfile";
import { createLogger } from "./logging.js";

const log = createLogger("lock");

/** Tunables for the robust lock. Defaults harden past the old bash 10s hard-fail. */
export interface FileLockTuning {
  /** Ms after which a held lock is considered stale (crashed holder). */
  stale: number;
  /** Total retry attempts to acquire a contended lock before giving up. */
  retries: number;
  /** Base backoff (ms) between retries (exponential, capped). */
  retryMinTimeout: number;
  /** Max backoff (ms) between retries. */
  retryMaxTimeout: number;
}

/** Baseline profile (== the historical StateManager defaults). Sites override per-need. */
export const DEFAULT_FILE_LOCK_TUNING: FileLockTuning = {
  stale: 15_000,
  // Enough attempts that ≥3 concurrent writers all eventually win their turn.
  retries: 50,
  retryMinTimeout: 20,
  retryMaxTimeout: 500,
};

export interface FileLockOptions {
  /** Parent dir of the lockfile. */
  dir: string;
  /** The lockfile path (proper-lockfile creates a sibling `<path>.lock`). */
  lockfile: string;
  /** Names the resource in the loud not-found + compromised errors. */
  label: string;
  /**
   * Missing-dir policy. `"assert"` throws if `dir` is absent (the caller owns its
   * lifecycle — e.g. an existing run dir). `"create"` mkdirs it `-p` first (e.g.
   * the shared `locks/` dir).
   */
  dirPolicy: "assert" | "create";
  tuning: FileLockTuning;
}

/**
 * Acquire the lock at `opts.lockfile`, run `fn`, and ALWAYS release — even if
 * `fn` throws. Returns whatever `fn` returns.
 */
export async function withFileLock<T>(opts: FileLockOptions, fn: () => Promise<T>): Promise<T> {
  if (opts.dirPolicy === "create") {
    await mkdir(opts.dir, { recursive: true });
  } else if (!existsSync(opts.dir)) {
    throw new Error(`cannot lock ${opts.label} — dir '${opts.dir}' does not exist`);
  }
  const release = await lock(opts.lockfile, {
    realpath: false,
    stale: opts.tuning.stale,
    retries: {
      retries: opts.tuning.retries,
      minTimeout: opts.tuning.retryMinTimeout,
      maxTimeout: opts.tuning.retryMaxTimeout,
      factor: 1.5,
    },
    onCompromised: (err) => {
      // Loud, never silent. Re-throw per proper-lockfile's contract.
      log.error(`lock for ${opts.label} was compromised: ${err.message}`);
      throw err;
    },
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
