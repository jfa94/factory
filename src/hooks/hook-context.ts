/**
 * WS9 — active-run context resolution for the guards.
 *
 * Ports the bash `runs/current` symlink resolution from
 * `pretooluse-pipeline-guards.sh` / `subagent-stop-transcript.sh` onto the WS1
 * seam. Distinguishes three cases (the bash hooks got this subtly right and it
 * must be preserved):
 *   - NO symlink            → no active run; guards pass through (`null`).
 *   - DANGLING symlink      → run state corrupted; FAIL CLOSED (throw) so the
 *                             caller denies rather than masking corruption.
 *   - VALID symlink         → parse RunState via StateManager; LOUD on a corrupt
 *                             state.json (never silently treated as "no run").
 *
 * The data dir is resolved via `resolveDataDir` (the Config seam) — that is PATH
 * RESOLUTION, not policy, so it does NOT taint the hardcoded TCB denylist (Δ W):
 * tcb.ts never imports config; this module only uses config to find WHERE the
 * data dir is, which is the same thing StateManager already does.
 */
import { existsSync } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { resolveDataDir, type DataDirOptions } from "../config/load.js";
import { StateManager } from "../core/state/index.js";
import { currentLinkPath } from "../core/state/index.js";
import { TaskStageEnum, type TaskStage } from "../core/stage-machine/index.js";
import type { RunState, TaskState } from "../types/index.js";

/** Thrown when `runs/current` is a dangling symlink (corrupt run state). */
export class BrokenRunStateError extends Error {
  constructor(public readonly target: string) {
    super(`runs/current symlink is broken (target: ${target}); failing closed`);
    this.name = "BrokenRunStateError";
  }
}

/** The resolved active run + the data dir it lives under. */
export interface ActiveRun {
  /** The data dir the run store lives under. */
  readonly dataDir: string;
  /** The parsed, validated run state. */
  readonly run: RunState;
}

/**
 * Resolve the active run, or `null` when there is no active run.
 *
 * @throws BrokenRunStateError when `runs/current` is a dangling symlink.
 * @throws ZodError/JsonParseError when state.json is corrupt (loud — never null).
 *
 * The data dir is resolved with `opts` (tests inject `dataDir`); if no data dir
 * can be resolved at all, there is no active run → `null`.
 */
export async function loadActiveRun(opts: DataDirOptions = {}): Promise<ActiveRun | null> {
  let dataDir: string;
  try {
    dataDir = resolveDataDir(opts);
  } catch {
    // No resolvable data dir (bare dev shell) — no active run to guard.
    return null;
  }

  const link = currentLinkPath(dataDir);
  // No symlink at all → no active run (pass through). lstat-based so we can tell
  // a dangling symlink (the link entry exists) from genuine absence.
  let isLink = false;
  try {
    const st = await lstat(link);
    isLink = st.isSymbolicLink() || st.isDirectory();
  } catch {
    return null;
  }
  if (!isLink) return null;

  // A symlink that does not resolve (existsSync follows it) is DANGLING → fail
  // closed. This is the corruption case the bash guard denies on.
  if (!existsSync(link)) {
    let target = "<unreadable>";
    try {
      target = await readlink(link);
    } catch {
      /* keep the placeholder */
    }
    throw new BrokenRunStateError(target);
  }

  // Valid symlink → parse the current run (LOUD on a corrupt state.json).
  const manager = new StateManager({ ...opts, dataDir });
  const run = await manager.readCurrent();
  if (run === null) return null;
  return { dataDir, run };
}

/**
 * The currently-relevant task + its in-flight stage, if it can be resolved.
 *
 * `taskId` resolution order mirrors the bash guard: explicit env
 * (`FACTORY_TASK_ID`), else the single in-flight task. Stage comes from the
 * persisted `TaskState.stage` cursor (written by the coroutine in lockstep with
 * status on every fold); status derivation (`statusToStage`) is kept only as
 * the legacy fallback for states that predate the cursor.
 */
export interface ActiveTask {
  readonly task: TaskState;
  /** The active in-flight stage (persisted cursor, status-derived fallback), or null if terminal/idle. */
  readonly stage: TaskStage | null;
}

/**
 * LEGACY FALLBACK: map an in-flight task status back to the stage it implies
 * (best-effort). Only consulted when the task has no persisted stage cursor;
 * status alone cannot tell `tests` from `exec` (both map to `executing` —
 * `producer_role` cannot disambiguate either, it lags the exec spawn), so the
 * cursor is the authoritative source.
 */
function statusToStage(status: TaskState["status"]): TaskStage | null {
  switch (status) {
    case "executing":
      // `tests` and `exec` both map to `executing`; without a cursor we assume
      // the FIRST executing sub-stage (the stricter, test-writer-scoped one).
      return TaskStageEnum.enum.tests;
    case "reviewing":
      return TaskStageEnum.enum.verify;
    case "shipping":
      return TaskStageEnum.enum.ship;
    case "pending":
    case "done":
    case "dropped":
      return null;
  }
}

/**
 * The active stage for guard scoping: null when the task is not in-flight;
 * else the persisted stage cursor (written by the coroutine in lockstep with
 * status on every fold), falling back to status derivation for legacy
 * states that predate the cursor.
 */
function activeStageOf(task: TaskState): TaskStage | null {
  if (statusToStage(task.status) === null) return null; // terminal/pending — cursor is history, not an active stage
  return task.stage ?? statusToStage(task.status);
}

/**
 * Resolve the active task for guard scoping. Prefers an explicit task id (env or
 * arg), else the single non-terminal task. Returns null when ambiguous (≥2
 * in-flight tasks with no explicit id) or none in-flight — the caller treats
 * null as "no task-scoped guard applies".
 */
export function resolveActiveTask(run: RunState, explicitTaskId?: string): ActiveTask | null {
  const taskId = explicitTaskId ?? process.env.FACTORY_TASK_ID ?? "";
  if (taskId.length > 0) {
    const task = run.tasks[taskId];
    if (!task) return null;
    return { task, stage: activeStageOf(task) };
  }
  const inFlight = Object.values(run.tasks).filter(
    (t) => t.status === "executing" || t.status === "reviewing" || t.status === "shipping",
  );
  if (inFlight.length !== 1) return null;
  const task = inFlight[0]!;
  return { task, stage: activeStageOf(task) };
}

/**
 * Whether the active task is in the TEST-WRITER phase (active stage `tests` AND
 * producer_role test-writer). The path-scope guard (pipeline-guards) uses this:
 * the test-writer may write only test paths. The stage comes from the resolved
 * ActiveTask (persisted cursor, status-derived fallback).
 */
export function isTestWriterPhase(active: ActiveTask | null): boolean {
  if (!active) return false;
  if (active.stage !== TaskStageEnum.enum.tests) return false;
  // producer_role is optional; when set it must be test-writer for the phase.
  return active.task.producer_role === undefined || active.task.producer_role === "test-writer";
}
