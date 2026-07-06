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
/* eslint-disable security/detect-non-literal-fs-filename -- read-only path resolution (exists/lstat/readlink) for the hook's own decision; no writes, paths are internal derived paths under evaluation */
import {existsSync} from 'node:fs'
import {lstat, readlink} from 'node:fs/promises'
import {isAbsolute, relative, sep} from 'node:path'
import {resolveDataDir, type DataDirOptions} from '../config/load.js'
import {StateManager} from '../core/state/index.js'
import {currentLinkPath, worktreesRoot} from '../core/state/index.js'
import {isValidId} from '../shared/ids.js'
import {at} from '../shared/index.js'
import {canonicalizePath} from './tcb.js'
import {TaskPhaseEnum, type TaskPhase} from '../core/phase-machine/index.js'
import type {RunState, TaskState} from '../types/index.js'

/** Thrown when `runs/current` is a dangling symlink (corrupt run state). */
export class BrokenRunStateError extends Error {
    constructor(public readonly target: string) {
        super(`runs/current symlink is broken (target: ${target}); failing closed`)
        this.name = 'BrokenRunStateError'
    }
}

/** The resolved active run + the data dir it lives under. */
export interface ActiveRun {
    /** The data dir the run store lives under. */
    readonly dataDir: string
    /** The parsed, validated run state. */
    readonly run: RunState
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
    let dataDir: string
    try {
        dataDir = resolveDataDir(opts)
    } catch {
        // No resolvable data dir (bare dev shell) — no active run to guard.
        return null
    }

    const link = currentLinkPath(dataDir)
    // No symlink at all → no active run (pass through). lstat-based so we can tell
    // a dangling symlink (the link entry exists) from genuine absence.
    let isLink = false
    try {
        const st = await lstat(link)
        isLink = st.isSymbolicLink() || st.isDirectory()
    } catch (err) {
        // Only genuine absence means "no active run". Anything else (EACCES, EIO, …)
        // is an unreadable data dir → rethrow, which the guard pipeline maps to a
        // fail-closed deny rather than a silent allow.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return null
        }
        throw err
    }
    if (!isLink) {
        return null
    }

    // A symlink that does not resolve (existsSync follows it) is DANGLING → fail
    // closed. This is the corruption case the bash guard denies on.
    if (!existsSync(link)) {
        let target = '<unreadable>'
        try {
            target = await readlink(link)
        } catch {
            /* keep the placeholder */
        }
        throw new BrokenRunStateError(target)
    }

    // Valid symlink → parse the current run (LOUD on a corrupt state.json).
    const manager = new StateManager({...opts, dataDir})
    const run = await manager.readCurrent()
    if (run === null) {
        return null
    }
    return {dataDir, run}
}

/**
 * Resolve the active run OWNED BY THE CURRENT SESSION, for the session-scoped Bash
 * guards (run-isolation L1.3). The owning session is read from
 * `CLAUDE_CODE_SESSION_ID` (the value `owner_session` was stamped from at run
 * create); the matching non-terminal run is found via {@link StateManager.findActiveByOwner}.
 *
 * Fail-SAFE: when no session id is present in the environment, fall back to the
 * legacy global `runs/current` resolution ({@link loadActiveRun}) so behavior is
 * unchanged (and never MORE permissive) where the env signal is unavailable. A
 * session id that owns no run → `null` (pass through), so a concurrent run owned by
 * another session is never inherited.
 */
export async function loadOwnerScopedRun(opts: DataDirOptions = {}): Promise<ActiveRun | null> {
    const env = opts.env ?? process.env
    const session = (env.CLAUDE_CODE_SESSION_ID ?? '').trim()
    if (session.length === 0) {
        // No owner signal → preserve today's global behavior (fail-safe, no regression).
        return loadActiveRun(opts)
    }
    let dataDir: string
    try {
        dataDir = resolveDataDir(opts)
    } catch {
        return null // bare dev shell — no run store to scope
    }
    const manager = new StateManager({...opts, dataDir})
    const run = await manager.findActiveByOwner(session)
    return run === null ? null : {dataDir, run}
}

/** A run+task ownership reference derived from a producer write path. */
export interface RunTaskRef {
    readonly run_id: string
    readonly task_id: string
}

/**
 * Derive the owning `{run_id, task_id}` from an absolute write path, or `null`
 * when the path is not inside a per-task worktree.
 *
 * This is the run-isolation anchor for the test-writer write-scope guard: a
 * producer (test-writer/implementer) writes into `<dataDir>/worktrees/<run_id>/<task_id>/…`
 * ({@link worktreesRoot}), so its Edit/Write `file_path` ALREADY encodes which run
 * and task own the write — no global pointer, no cwd, no session payload needed.
 * An unrelated session editing a checkout outside the worktree root resolves to
 * `null` → that guard arm does not fire (the spurious cross-session block fix).
 *
 * Both sides are canonicalized (normalize + realpath, reusing {@link canonicalizePath})
 * so `..`/symlink evasions resolve to the same under-root decision as a direct
 * path. The first two segments below the root are the run-id and task-id; both
 * must be valid id segments (`^[a-zA-Z0-9_-]{1,64}$`) or the path is treated as
 * not a recognizable worktree path (`null`) rather than throwing.
 */
export function runTaskForPath(dataDir: string, absPath: string): RunTaskRef | null {
    if (dataDir.length === 0 || absPath.length === 0) {
        return null
    }
    const rootCanon = canonicalizePath(worktreesRoot(dataDir))
    const pathCanon = canonicalizePath(absPath)
    const rel = relative(rootCanon, pathCanon)
    // Outside the worktree root (`..`-prefixed or absolute, or the root itself) → no owner.
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return null
    }
    const segments = rel.split(sep)
    if (segments.length < 2) {
        return null
    } // need at least <run_id>/<task_id>
    const [run_id, task_id] = segments
    if (run_id == null || run_id.length === 0 || task_id == null || task_id.length === 0) {
        return null
    }
    if (!isValidId(run_id) || !isValidId(task_id)) {
        return null
    }
    return {run_id, task_id}
}

/**
 * The currently-relevant task + its in-flight phase, if it can be resolved.
 *
 * `taskId` resolution order mirrors the bash guard: explicit env
 * (`FACTORY_TASK_ID`), else the single in-flight task. Phase comes from the
 * persisted `TaskState.phase` cursor — the orchestrator writes it in lockstep
 * with status on every record, and the schema REJECTS an in-flight row without
 * one (refineTaskCrossFields), so no derivation fallback exists.
 */
export interface ActiveTask {
    readonly task: TaskState
    /** The active in-flight phase (persisted cursor), or null if terminal/idle. */
    readonly phase: TaskPhase | null
}

const IN_FLIGHT_STATUSES: ReadonlySet<TaskState['status']> = new Set(['executing', 'reviewing', 'shipping'])

/**
 * The active phase for guard scoping: null when the task is not in-flight
 * (cursor is history, not an active phase); else the persisted phase cursor.
 */
function activePhaseOf(task: TaskState): TaskPhase | null {
    if (!IN_FLIGHT_STATUSES.has(task.status)) {
        return null
    }
    return task.phase ?? null
}

/**
 * Resolve the active task for guard scoping. Prefers an explicit task id (env or
 * arg), else the single non-terminal task. Returns null when ambiguous (≥2
 * in-flight tasks with no explicit id) or none in-flight — the caller treats
 * null as "no task-scoped guard applies".
 */
export function resolveActiveTask(run: RunState, explicitTaskId?: string): ActiveTask | null {
    const taskId = explicitTaskId ?? process.env.FACTORY_TASK_ID ?? ''
    if (taskId.length > 0) {
        const task = run.tasks[taskId]
        if (!task) {
            return null
        }
        return {task, phase: activePhaseOf(task)}
    }
    const inFlight = Object.values(run.tasks).filter(
        (t) => t.status === 'executing' || t.status === 'reviewing' || t.status === 'shipping'
    )
    if (inFlight.length !== 1) {
        return null
    }
    const task = at(inFlight, 0)
    return {task, phase: activePhaseOf(task)}
}

/**
 * Whether the active task is in the TEST-WRITER phase (active phase `tests` AND
 * producer_role test-writer). The path-scope guard (pipeline-guards) uses this:
 * the test-writer may write only test paths. The phase comes from the resolved
 * ActiveTask (persisted cursor, status-derived fallback).
 */
export function isTestWriterPhase(active: ActiveTask | null): boolean {
    if (!active) {
        return false
    }
    if (active.phase !== TaskPhaseEnum.enum.tests) {
        return false
    }
    // producer_role is optional; when set it must be test-writer for the phase.
    return active.task.producer_role === undefined || active.task.producer_role === 'test-writer'
}
