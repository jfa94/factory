/**
 * WS9 — active-run context resolution for the guards.
 *
 * {@link loadOwnerScopedRun} resolves the run a hook invocation belongs to via a
 * 3-tier order (Decision 61 — the global `runs/current` pointer is retired, so there is no
 * repo-less fallback to race):
 *   1. OWNER SESSION — `CLAUDE_CODE_SESSION_ID` set → the run that session owns
 *      (`findActiveByOwner`), never leaking a concurrent run owned by another session.
 *   2. CWD REPO — no session id but a cwd → the cwd repo's per-repo current pointer
 *      (`resolveRepo` → `readCurrentForRepo`); an underivable repo (UsageError) falls
 *      through, any other resolution failure surfaces LOUD.
 *   3. SCAN — neither → the newest non-terminal run in the store.
 * A permission/IO failure at any tier propagates (guards fail closed); only genuine
 * absence resolves to `null` (guards pass through).
 *
 * The data dir is resolved via `resolveDataDir` (the Config seam) — that is PATH
 * RESOLUTION, not policy, so it does NOT taint the hardcoded TCB denylist (Δ W):
 * tcb.ts never imports config; this module only uses config to find WHERE the
 * data dir is, which is the same thing StateManager already does.
 */
import {isAbsolute, relative, sep} from 'node:path'
import {resolveDataDir, type DataDirOptions} from '../config/load.js'
import {StateManager, isTerminalRunStatus} from '../core/state/index.js'
import {worktreesRoot} from '../core/state/index.js'
import {resolveRepo, DefaultGitClient, type GitClient} from '../git/index.js'
import {UsageError} from '../shared/usage-error.js'
import {isValidId} from '../shared/ids.js'
import {at} from '../shared/index.js'
import {canonicalizePath} from './tcb.js'
import {TaskPhaseEnum, type TaskPhase} from '../core/phase-machine/index.js'
import type {RunState, TaskState} from '../types/index.js'

/** The resolved active run + the data dir it lives under. */
export interface ActiveRun {
    /** The data dir the run store lives under. */
    readonly dataDir: string
    /** The parsed, validated run state. */
    readonly run: RunState
}

/** Options for {@link loadOwnerScopedRun}: the data-dir seam + the cwd/git seam. */
export interface OwnerScopedRunOptions extends DataDirOptions {
    /** The invoking session's cwd (CC pipes it in the hook payload) — the repo anchor. */
    readonly cwd?: string
    /** Test seam for repo resolution; defaults to {@link DefaultGitClient}. */
    readonly gitClient?: GitClient
}

/**
 * Resolve the active run for the guards (run-isolation L1.3), in a strict order so
 * the global repo-less `runs/current` pointer is never needed (Decision 61):
 *
 *   (a) session present (`CLAUDE_CODE_SESSION_ID`) → the run THIS session owns
 *       ({@link StateManager.findActiveByOwner}); `null` if none, so a concurrent
 *       run owned by another session is never inherited.
 *   (b) no session but a `cwd` → this repo's current run (the per-repo pointer,
 *       {@link StateManager.readCurrentForRepo}). A repo with no current pointer, or
 *       an underivable repo (not a checkout / no origin) falls through to (c).
 *   (c) no session, no usable cwd → the newest NON-TERMINAL run via
 *       {@link StateManager.listRuns}. NOT null: the deny arms only need "a run is
 *       active", and returning null in a degraded env would silently re-open the
 *       nested-shell / ship gates.
 *
 * Corruption stays LOUD: a dangling per-repo pointer (deleted run) is genuine
 * absence → falls through; a corrupt state.json behind a live pointer throws via
 * `readCurrentForRepo`, which the guard pipeline maps to a fail-closed deny.
 */
export async function loadOwnerScopedRun(opts: OwnerScopedRunOptions = {}): Promise<ActiveRun | null> {
    let dataDir: string
    try {
        dataDir = resolveDataDir(opts)
    } catch {
        return null // bare dev shell — no run store to scope
    }
    const manager = new StateManager({...opts, dataDir})

    // (a) session-scoped — the run this session owns (never a foreign run).
    const env = opts.env ?? process.env
    const session = (env.CLAUDE_CODE_SESSION_ID ?? '').trim()
    if (session.length > 0) {
        const run = await manager.findActiveByOwner(session)
        return run === null ? null : {dataDir, run}
    }

    // (b) no session but a cwd → this repo's current run (per-repo pointer).
    if (opts.cwd !== undefined && opts.cwd.length > 0) {
        const gitClient = opts.gitClient ?? new DefaultGitClient()
        try {
            const repo = await resolveRepo({cwd: opts.cwd, gitClient})
            const run = await manager.readCurrentForRepo(repo)
            if (run !== null) {
                return {dataDir, run}
            }
            // repo has no current pointer yet → fall through to the scan
        } catch (err) {
            // Only the EXPECTED negative (not a checkout / no origin) falls through;
            // a broken git env must surface (guards fail closed), not masquerade.
            if (!(err instanceof UsageError)) {
                throw err
            }
        }
    }

    // (c) no session, no usable cwd → newest non-terminal run (never null in a
    //     degraded env — the deny arms only need "a run is active").
    const runs = await manager.listRuns()
    const active = runs.find((r) => !isTerminalRunStatus(r.status))
    return active === undefined ? null : {dataDir, run: active}
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
