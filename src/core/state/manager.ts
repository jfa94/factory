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
/* eslint-disable security/detect-non-literal-fs-filename -- fs on internal derived paths (run/spec/state/repo/data dirs), never external input; runtime write-danger is covered by the TCB write-deny hook */
import {mkdir, readFile, readdir, rename, rm, symlink, unlink} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {withFileLock, DEFAULT_FILE_LOCK_TUNING, type FileLockTuning} from '../../shared/file-lock.js'
import {atomicWriteFile} from '../../shared/atomic-write.js'
import {parseJson, stringifyJson} from '../../shared/json.js'
import {nowIso} from '../../shared/time.js'
import {createLogger} from '../../shared/logging.js'
import {resolveDataDir, type DataDirOptions} from '../../config/load.js'
import {currentLinkPath, currentRepoLinkPath, runDir, runsRoot, runStatePath, specDir, RUNS_DIR} from './paths.js'
import {parseRunState, type RunState, type SpecPointer, type TaskState, isTerminalRunStatus} from './schema.js'
import {UsageError} from '../../shared/usage-error.js'
import {at} from '../../shared/index.js'

const log = createLogger('state')

/**
 * Tunables for the robust lock. Now the shared {@link FileLockTuning}; kept as a
 * local alias so the re-export from `./index.ts` stays stable.
 */
export type LockTuning = FileLockTuning

const DEFAULT_LOCK_TUNING: LockTuning = DEFAULT_FILE_LOCK_TUNING

export interface StateManagerOptions extends DataDirOptions {
    /** Override lock tuning (tests use a tighter window). */
    lock?: Partial<LockTuning>
}

/** Arguments to {@link StateManager.create}. */
export interface CreateRunArgs {
    run_id: string
    spec: SpecPointer
    execution_mode?: RunState['execution_mode']
    ship_mode?: RunState['ship_mode']
    /** The owning Claude Code session id (Prompt J — session-scoped Stop gate). */
    owner_session?: RunState['owner_session']
    /** The per-run staging branch to PIN on the row (Decision 33). */
    staging_branch: RunState['staging_branch']
    /** Quota-gate bypass from `--ignore-quota`; persisted so both orchestrators skip the gate. */
    ignore_quota?: RunState['ignore_quota']
    /** e2e-phase opt-in from `--e2e` (Decision 39); persisted so `wantsE2e` reads it live. */
    e2e?: RunState['e2e']
    /** `/factory:debug` session marker (Decision 39, Task 4/6); mirrors `e2e`/`ignore_quota`. */
    debug?: RunState['debug']
}

export class StateManager {
    readonly dataDir: string
    private readonly lockTuning: LockTuning

    constructor(opts: StateManagerOptions = {}) {
        this.dataDir = resolveDataDir(opts)
        this.lockTuning = {...DEFAULT_LOCK_TUNING, ...(opts.lock ?? {})}
    }

    // ---- paths -------------------------------------------------------------

    private statePath(runId: string): string {
        return runStatePath(this.dataDir, runId)
    }

    private lockfilePath(runId: string): string {
        // Dedicated lockfile under the run dir; NOT state.json (so the atomic
        // rename of state.json never collides with the lock).
        return join(runDir(this.dataDir, runId), 'state.lock')
    }

    /**
     * Reject any state file not stamped with the CURRENT schema version, with a clear
     * UsageError instead of a raw ZodError. ABSENT rejects too — every writer stamps
     * the version, so an unstamped file predates the current schema. Ephemeral runs
     * can't be migrated; the remedy is always a fresh run.
     */
    private static guardedParse(raw: unknown, context: string): RunState {
        const v = (raw as Record<string, unknown> | null)?.schema_version
        if (v !== 3) {
            throw new UsageError(
                `run state at '${context}' uses schema v${JSON.stringify(v)}; only v3 is supported — this state was created by an older factory version; start a fresh run`
            )
        }
        return parseRunState(raw)
    }

    private specLockfilePath(repo: string, specId: string): string {
        // Dedicated lockfile under the durable spec dir, NOT the spec request, so a
        // scan→create critical section serializes per (repo, spec_id) without
        // colliding with spec writes.
        return join(specDir(this.dataDir, repo, specId), 'create.lock')
    }

    // ---- lock --------------------------------------------------------------

    /**
     * Acquire `lockfilePath` (whose parent `dir` must already exist), run `fn`, and
     * always release. `realpath:false` lets us lock a path whose target may be
     * mid-rename or not yet exist (proper-lockfile creates `<path>.lock`).
     * `label` names the resource in the loud not-found + compromised errors.
     */
    private async runWithLock<T>(dir: string, lockfilePath: string, label: string, fn: () => Promise<T>): Promise<T> {
        // The caller owns `dir`'s lifecycle (run/spec dir mkdir'd before first lock),
        // so assert it exists rather than create it.
        return withFileLock({dir, lockfile: lockfilePath, label, dirPolicy: 'assert', tuning: this.lockTuning}, fn)
    }

    /**
     * Run `fn` while holding the per-run lock. The lockfile's parent (the run dir)
     * must already exist — `create` mkdirs it before first lock; mutators lock an
     * existing run.
     */
    private async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
        return this.runWithLock(runDir(this.dataDir, runId), this.lockfilePath(runId), `run '${runId}'`, fn)
    }

    /**
     * Run `fn` while holding the per-spec lock, keyed by `(repo, specId)`. The
     * durable spec dir is the lock parent — it always exists once the spec is
     * resolved, so this is a stable serialization point for the resolve-or-reuse
     * scan→create critical section (two concurrent same-spec creates can't both
     * observe "no active run" and mint two orphan runs; the per-run clobber guard
     * only protects against a same run_id collision). Distinct lockfile from
     * {@link withLock}, so the nested `create` call inside the body never deadlocks.
     */
    async withSpecLock<T>(repo: string, specId: string, fn: () => Promise<T>): Promise<T> {
        return this.runWithLock(
            specDir(this.dataDir, repo, specId),
            this.specLockfilePath(repo, specId),
            `spec '${repo}/${specId}'`,
            fn
        )
    }

    // ---- create ------------------------------------------------------------

    /**
     * Create a brand-new run. Mkdirs the run store layout, writes the initial
     * state.json atomically under the lock, and (best-effort) points `runs/current`
     * at it. Refuses to clobber an existing run dir.
     */
    async create(args: CreateRunArgs): Promise<RunState> {
        const dir = runDir(this.dataDir, args.run_id)
        // Cheap fast-path guard — NOT authoritative on its own (racy). The binding
        // clobber check is re-run INSIDE the lock below so two concurrent create()
        // calls for the same run_id cannot both pass it (TOCTOU).
        if (existsSync(this.statePath(args.run_id))) {
            throw new Error(`state: run '${args.run_id}' already exists`)
        }
        // The lockfile's parent (the run dir) must exist before we can lock it.
        await mkdir(join(dir, 'holdouts'), {recursive: true})
        await mkdir(join(dir, 'reviews'), {recursive: true})

        const now = nowIso()
        const state = parseRunState({
            run_id: args.run_id,
            status: 'running',
            execution_mode: args.execution_mode ?? 'sequential',
            ship_mode: args.ship_mode ?? 'live',
            // Stamp the owning session only when known (best-effort) — an absent owner
            // leaves the field undefined and the Stop gate falls back to unscoped behavior.
            ...(args.owner_session !== undefined ? {owner_session: args.owner_session} : {}),
            staging_branch: args.staging_branch,
            ...(args.ignore_quota !== undefined ? {ignore_quota: args.ignore_quota} : {}),
            ...(args.e2e !== undefined ? {e2e: args.e2e} : {}),
            ...(args.debug !== undefined ? {debug: args.debug} : {}),
            spec: args.spec,
            tasks: {},
            started_at: now,
            updated_at: now,
            ended_at: null,
        })

        await this.withLock(args.run_id, async () => {
            // AUTHORITATIVE clobber guard: re-check inside the critical section so the
            // loser of a same-id create() race throws here instead of overwriting the
            // winner's state.json (last-writer-wins). Exactly one create() wins.
            if (existsSync(this.statePath(args.run_id))) {
                throw new Error(`state: run '${args.run_id}' already exists`)
            }
            await atomicWriteFile(this.statePath(args.run_id), stringifyJson(state))
        })

        // Touch the append-only logs so downstream appenders need no existence check.
        await atomicWriteFile(join(dir, 'audit.jsonl'), '')
        await atomicWriteFile(join(dir, 'metrics.jsonl'), '')

        await this.pointCurrentAt(state)
        return state
    }

    // ---- read (lock-free) --------------------------------------------------

    /**
     * Read + validate a run's state. LOCK-FREE: the atomic rename on the writer
     * side guarantees a reader sees a whole file. LOUD on a missing run or a
     * schema/JSON violation (never a silent partial).
     */
    async read(runId: string): Promise<RunState> {
        const path = this.statePath(runId)
        const raw = await readFile(path, 'utf8')
        return StateManager.guardedParse(parseJson(raw, path), path)
    }

    /**
     * True iff a RunState exists on disk for this run id. Synchronous,
     * no read/parse — mirrors the existence check `create()` already uses
     * internally before writing. Lets a caller distinguish "no run was ever
     * created" from a genuine read failure without parsing.
     */
    exists(runId: string): boolean {
        return existsSync(this.statePath(runId))
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
        return this.readThroughLink(currentLinkPath(this.dataDir))
    }

    /**
     * Read the run the PER-REPO current pointer (`current/<repo-key>`, L2.7) names —
     * the authoritative pointer the human CLI resolves per checkout. A per-repo MISS
     * (no pointer for this repo yet) falls back to the legacy GLOBAL `runs/current`,
     * but ONLY adopts it when it belongs to the SAME repo — so a pre-upgrade in-flight
     * run (global-only) still resolves, while another repo's run never leaks in.
     * Loud on a corrupt state.json behind either pointer (same contract as readCurrent).
     */
    async readCurrentForRepo(repo: string): Promise<RunState | null> {
        const viaRepo = await this.readThroughLink(currentRepoLinkPath(this.dataDir, repo))
        if (viaRepo !== null) {
            return viaRepo
        }
        // Per-repo miss → legacy read-through, scoped to the SAME repo (never cross-repo).
        const legacy = await this.readCurrent()
        return legacy !== null && legacy.spec.repo === repo ? legacy : null
    }

    /**
     * Read + validate a run's state THROUGH a `current`-style directory symlink (the
     * OS follows the link during the path walk, so no readlink is needed). Returns
     * null ONLY on genuine ABSENCE (missing/dangling link → ENOENT); a corrupt/invalid
     * state.json propagates LOUDLY (swallowing it would make a corrupt active run
     * indistinguishable from "no current run"). Shared by {@link readCurrent} and
     * {@link readCurrentForRepo}.
     */
    private async readThroughLink(link: string): Promise<RunState | null> {
        if (!existsSync(link)) {
            return null
        }
        const statePath = join(link, 'state.json')
        let raw: string
        try {
            raw = await readFile(statePath, 'utf8')
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return null
            }
            throw err
        }
        return StateManager.guardedParse(parseJson(raw, statePath), statePath)
    }

    // ---- enumerate (lock-free) ---------------------------------------------

    /**
     * Enumerate every run in the store, newest-first (run-id descending — the id is
     * lexicographically chronological). Each run dir's state.json is read + validated
     * through {@link read}. Non-directory entries (the `runs/current` symlink and any
     * `*.tmp.<pid>` link create() leaves behind) are excluded. A run dir without a
     * state.json (mid-creation, or cleaned) is skipped silently; one whose state.json
     * is unreadable/corrupt/invalid is skipped with a LOUD warning — a single corrupt
     * historical run must not brick `run create`'s resolve-or-reuse scan. (Targeted
     * {@link read} keeps its loud-on-corruption contract; only this bulk scan tolerates
     * a bad entry, and never silently.)
     */
    async listRuns(): Promise<RunState[]> {
        let entries
        try {
            entries = await readdir(runsRoot(this.dataDir), {withFileTypes: true})
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return []
            }
            throw err
        }
        const runs: RunState[] = []
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue
            } // excludes the `current` + temp symlinks
            try {
                runs.push(await this.read(entry.name))
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    continue
                } // no state.json yet
                log.warn(`state: skipping unreadable run '${entry.name}': ${(err as Error).message}`)
            }
        }
        return runs.sort((a, b) => b.run_id.localeCompare(a.run_id))
    }

    /**
     * Find the newest NON-terminal run for `(repo, specId)`, or null. Powers the
     * resolve-or-reuse path of `run create`: a repeated create returns the live run
     * instead of spawning an orphan. Matches on BOTH repo and spec_id (a spec id is
     * `<issue>-<slug>` — unique within a repo, but not necessarily across repos).
     */
    async findActiveBySpec(repo: string, specId: string): Promise<RunState | null> {
        const runs = await this.listRuns() // newest-first
        for (const r of runs) {
            if (r.spec.repo === repo && r.spec.spec_id === specId && !isTerminalRunStatus(r.status)) {
                return r
            }
        }
        return null
    }

    /**
     * ALL non-terminal runs owned by `session` (its `owner_session`), newest-first
     * (empty session → `[]`). The raw list behind {@link findActiveByOwner}: callers
     * that must DISTINGUISH "none owned" from "ambiguous (≥2 owned)" — e.g. `run cancel`,
     * which fails LOUD on ambiguity rather than guessing which run to abandon — branch
     * on `.length`.
     */
    async findAllActiveByOwner(session: string): Promise<RunState[]> {
        if (session.length === 0) {
            return []
        }
        const runs = await this.listRuns() // newest-first
        return runs.filter((r) => r.owner_session === session && !isTerminalRunStatus(r.status))
    }

    /**
     * Find the SINGLE non-terminal run owned by `session` (its `owner_session`), or
     * null. Powers the session-scoped Bash guards (run-isolation L1.3): a guard fires
     * only for the run the stopping/acting session actually owns, never a concurrent
     * run in another repo. An empty session, no match, or ≥2 matches (ambiguous — one
     * session minting runs in two repos) all return null, so the caller fails SAFE
     * (passes through) rather than gating the wrong run. Callers that must tell "none"
     * from "ambiguous" apart use {@link findAllActiveByOwner} and branch on its length.
     */
    async findActiveByOwner(session: string): Promise<RunState | null> {
        const owned = await this.findAllActiveByOwner(session)
        return owned.length === 1 ? at(owned, 0) : null
    }

    // ---- update (locked read-modify-write) ---------------------------------

    /**
     * Atomically mutate a run under the lock. `mutator` receives the current state
     * and returns the next state; the result is re-validated through the schema
     * (so a mutator cannot persist an out-of-enum value) and `updated_at` is
     * stamped. This is the ONLY write path for an existing run.
     */
    async update(runId: string, mutator: (state: RunState) => RunState | Promise<RunState>): Promise<RunState> {
        return this.withLock(runId, async () => {
            const current = await this.read(runId)
            const next = await mutator(current)
            // Identity is the storage key: run_id keys the directory and (repo, spec_id)
            // is the durable spec address. A mutator that changes either would persist a
            // state.json whose identity disagrees with its path, silently breaking
            // addressability. Pin both — a mutator must never rewrite identity.
            if (next.run_id !== runId) {
                throw new Error(
                    `state: update mutator changed run_id ('${runId}' → '${next.run_id}') — identity is immutable`
                )
            }
            if (
                next.spec.repo !== current.spec.repo ||
                next.spec.spec_id !== current.spec.spec_id ||
                next.spec.issue_number !== current.spec.issue_number
            ) {
                throw new Error(
                    `state: update mutator changed the spec pointer for run '${runId}' — identity is immutable`
                )
            }
            const validated = parseRunState({
                ...next,
                updated_at: nowIso(),
            })
            await atomicWriteFile(this.statePath(runId), stringifyJson(validated))
            return validated
        })
    }

    /**
     * Convenience: mutate a single task in place. Throws if the task is absent
     * (a typo'd task id is a loud error, not a silent create).
     */
    async updateTask(runId: string, taskId: string, mutator: (task: TaskState) => TaskState): Promise<RunState> {
        return this.update(runId, (state) => {
            const task = state.tasks[taskId]
            if (!task) {
                throw new Error(`state: run '${runId}' has no task '${taskId}'`)
            }
            return {...state, tasks: {...state.tasks, [taskId]: mutator(task)}}
        })
    }

    // ---- finalize ----------------------------------------------------------

    /**
     * Finalize a run to a TERMINAL status (Decision 22/24 — finalize is terminal,
     * never spins). Refuses a non-terminal status. Stamps `ended_at`. Idempotent
     * for the same terminal status.
     */
    async finalize(runId: string, status: RunState['status']): Promise<RunState> {
        if (!isTerminalRunStatus(status)) {
            throw new Error(`state: finalize requires a terminal status (completed|failed|superseded); got '${status}'`)
        }
        return this.update(runId, (state) => {
            if (isTerminalRunStatus(state.status) && state.status !== status) {
                throw new Error(
                    `state: run '${runId}' already terminal as '${state.status}'; cannot re-finalize as '${status}'`
                )
            }
            // Clear any quota checkpoint: it is valid ONLY while paused|suspended
            // (refineRunCrossFields), so a paused/suspended run that finalizes to a
            // terminal status must drop it or re-validation throws. Finalize is
            // terminal — there is no resume horizon to preserve.
            return {...state, status, quota: undefined, ended_at: state.ended_at ?? nowIso()}
        })
    }

    // ---- current symlink ---------------------------------------------------

    /**
     * Repoint the current pointers at a freshly-created run (L2.6/L2.7):
     *   - the PER-REPO pointer `current/<repo-key>` → `../runs/<run-id>` (authoritative
     *     for the human CLI per checkout), and
     *   - the legacy GLOBAL `runs/current` → `<run-id>` (the repo-less "most-recent"
     *     fallback the degraded hook/stop paths still read).
     *
     * CLOBBER GUARD (L2.6) — runs BEFORE any write and throws LOUD (NOT swallowed by the
     * best-effort symlink catch below): if THIS repo's current pointer already names a
     * still-live run owned by a DIFFERENT known session, refuse to hide it. Same-repo
     * concurrent runs by distinct sessions are thus serialized, while cross-repo creates
     * (a different repo's pointer) never trip it. The just-created run's `state.json`
     * already exists, so it stays addressable via `--run <id>` after the throw.
     * Degrades safe (no refusal) when either owner is unknown — today's last-wins behavior.
     */
    private async pointCurrentAt(state: RunState): Promise<void> {
        const repo = state.spec.repo
        const existing = await this.readCurrentForRepo(repo)
        if (
            existing !== null &&
            existing.run_id !== state.run_id &&
            !isTerminalRunStatus(existing.status) &&
            existing.owner_session !== undefined &&
            state.owner_session !== undefined &&
            existing.owner_session !== state.owner_session
        ) {
            throw new Error(
                `state: refusing to repoint current for repo '${repo}' — run '${existing.run_id}' is ` +
                    `still live (owned by a different session '${existing.owner_session}'). Run ` +
                    `'${state.run_id}' was created and is addressable via \`--run ${state.run_id}\`; ` +
                    `finalize or rescue '${existing.run_id}' before starting a concurrent run in this repo.`
            )
        }
        // Per-repo pointer lives one level under <dataDir>/current, so it targets ../runs/<id>.
        await this.repointSymlink(currentRepoLinkPath(this.dataDir, repo), join('..', RUNS_DIR, state.run_id))
        // Legacy global pointer lives under runs/, so it targets the bare <id>.
        await this.repointSymlink(currentLinkPath(this.dataDir), join(state.run_id))
    }

    /**
     * Atomically-ish repoint a `current`-style symlink at `target` (write a temp link
     * then rename). Best-effort: a failure is logged, not fatal — `current` is a
     * convenience pointer, not load-bearing state.
     */
    private async repointSymlink(link: string, target: string): Promise<void> {
        const tmp = `${link}.tmp.${process.pid}`
        try {
            await mkdir(dirname(link), {recursive: true})
            await unlink(tmp).catch(() => {
                /* best-effort cleanup */
            })
            await symlink(target, tmp)
            await rm(link, {force: true, recursive: false}).catch(() => {
                /* best-effort cleanup */
            })
            await rename(tmp, link)
        } catch (err) {
            log.warn(`state: could not update current pointer '${link}' → '${target}': ${(err as Error).message}`)
            await unlink(tmp).catch(() => {
                /* best-effort cleanup */
            })
        }
    }
}

/** Re-export the store subdir name for callers that enumerate runs. */
export {RUNS_DIR}
