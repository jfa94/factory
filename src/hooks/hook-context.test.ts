/**
 * WS9 — active-run resolution tests for {@link loadOwnerScopedRun}, the 3-tier
 * resolver (Decision 61, global `runs/current` retired): (1) owner session id → the run that
 * session owns; (2) no session but a cwd → the cwd's per-repo current pointer;
 * (3) neither → scan for the newest non-terminal run. Plus the pure task/phase
 * resolution (persisted phase cursor preferred; status derivation is the legacy
 * fallback). Uses a real on-disk run store so resolution is genuinely exercised.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtempSync, rmSync, chmodSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {StateManager} from '../core/state/index.js'
import {FakeGitClient} from '../git/index.js'
import {loadOwnerScopedRun, resolveActiveTask, isTestWriterPhase, runTaskForPath} from './hook-context.js'
import {worktreesRoot} from '../core/state/index.js'
import type {RunState, TaskState} from '../types/index.js'

const SPEC = {repo: 'o/n', spec_id: '1-x', issue_number: 1} as const

/** A FakeGitClient whose origin resolves to `slug` (or no origin when slug is null). */
function git(slug: string | null): FakeGitClient {
    const g = new FakeGitClient()
    if (slug !== null) {
        g.setRemoteUrl('origin', `git@github.com:${slug}.git`)
    }
    return g
}

describe('loadOwnerScopedRun — 3-tier active-run resolution (Decision 61)', () => {
    let dataDir: string
    beforeEach(() => {
        dataDir = mkdtempSync(join(tmpdir(), 'hc-owner-'))
    })
    afterEach(() => {
        rmSync(dataDir, {recursive: true, force: true})
    })

    // --- tier 1: owner session id ---
    it('with CLAUDE_CODE_SESSION_ID set → resolves the run THAT session owns', async () => {
        const mgr = new StateManager({dataDir})
        await mgr.create({run_id: 'run-1', staging_branch: 'staging-run-1', spec: SPEC, owner_session: 'sess-A'})
        const active = await loadOwnerScopedRun({dataDir, env: {CLAUDE_CODE_SESSION_ID: 'sess-A'}})
        expect(active?.run.run_id).toBe('run-1')
        expect(active?.dataDir).toBe(dataDir)
    })

    it('with a session id that owns NO run → null, even though another session has a live run', async () => {
        // A concurrent run owned by another session must NOT leak to an unrelated
        // session — tier 1 does not fall through to the cwd/scan tiers.
        const mgr = new StateManager({dataDir})
        await mgr.create({run_id: 'run-1', staging_branch: 'staging-run-1', spec: SPEC, owner_session: 'sess-B'})
        const active = await loadOwnerScopedRun({dataDir, env: {CLAUDE_CODE_SESSION_ID: 'sess-A'}})
        expect(active).toBeNull()
    })

    // --- tier 2: no session, cwd → per-repo current pointer ---
    it("with NO session but a cwd → resolves the cwd repo's current run, never another repo's", async () => {
        const mgr = new StateManager({dataDir})
        // Older run in o/n; newer run in other/repo. The scan tier would pick the newer;
        // the cwd tier must pick o/n's per-repo pointer instead.
        await mgr.create({run_id: 'run-20260101-000000', staging_branch: 'staging-a', spec: SPEC})
        await mgr.create({
            run_id: 'run-20260102-000000',
            staging_branch: 'staging-b',
            spec: {repo: 'other/repo', spec_id: '2-y', issue_number: 2},
        })
        const active = await loadOwnerScopedRun({dataDir, env: {}, cwd: '/x', gitClient: git('o/n')})
        expect(active?.run.run_id).toBe('run-20260101-000000')
    })

    it('with a cwd whose repo is undeterminable (no origin) → falls through to the scan tier', async () => {
        const mgr = new StateManager({dataDir})
        await mgr.create({run_id: 'run-1', staging_branch: 'staging-run-1', spec: SPEC})
        // resolveRepo throws UsageError → swallowed → tier 3 scan still finds the run.
        const active = await loadOwnerScopedRun({dataDir, env: {}, cwd: '/x', gitClient: git(null)})
        expect(active?.run.run_id).toBe('run-1')
    })

    // --- tier 3: no session, no cwd → newest non-terminal scan ---
    it('with neither a session nor a cwd → scans for the newest non-terminal run', async () => {
        const mgr = new StateManager({dataDir})
        await mgr.create({run_id: 'run-1', staging_branch: 'staging-run-1', spec: SPEC, owner_session: 'sess-B'})
        const active = await loadOwnerScopedRun({dataDir, env: {}})
        expect(active?.run.run_id).toBe('run-1')
    })

    it('no run at all → null (guards pass through)', async () => {
        const active = await loadOwnerScopedRun({dataDir, env: {}})
        expect(active).toBeNull()
    })

    it('UNREADABLE runs dir (EACCES) on the scan tier → rethrows (guards fail closed), never a silent null', async () => {
        // A permission failure is NOT "no active run": swallowing it would let every
        // guard silently allow while a run may be active. Only ENOENT means absence.
        const mgr = new StateManager({dataDir})
        await mgr.create({run_id: 'run-1', staging_branch: 'staging-run-1', spec: SPEC})
        chmodSync(join(dataDir, 'runs'), 0o000)
        try {
            await expect(loadOwnerScopedRun({dataDir, env: {}})).rejects.toMatchObject({code: 'EACCES'})
        } finally {
            chmodSync(join(dataDir, 'runs'), 0o755)
        }
    })

    it('unresolvable data dir → null (bare dev shell, no active run)', async () => {
        // resolveDataDir throws when nothing identifies a data dir; loadOwnerScopedRun
        // swallows THAT (path resolution) into null.
        const active = await loadOwnerScopedRun({dataDir: '', env: {}})
        expect(active).toBeNull()
    })
})

// --- pure derivation -------------------------------------------------------

function task(over: Partial<TaskState> = {}): TaskState {
    return {
        task_id: 't1',
        status: 'pending',
        depends_on: [],
        risk_tier: 'low',
        escalation_rung: 0,
        reviewers: [],
        ...over,
    } as TaskState
}

function run(tasks: Record<string, TaskState>): RunState {
    return {
        schema_version: 3,
        run_id: 'run-x',
        staging_branch: 'staging-run-x',
        status: 'running',
        execution_mode: 'balanced',
        spec: SPEC,
        tasks,
        ship_mode: 'live',
        ignore_quota: false,
        human_touches: [],
        misses: [],
        e2e: false,
        debug: false,
        started_at: 't',
        updated_at: 't',
        ended_at: null,
    }
}

describe('resolveActiveTask — task selection (cursor written in lockstep with status)', () => {
    const origTaskId = process.env.FACTORY_TASK_ID
    afterEach(() => {
        if (origTaskId === undefined) {
            delete process.env.FACTORY_TASK_ID
        } else {
            process.env.FACTORY_TASK_ID = origTaskId
        }
    })

    it('single executing task → its cursor phase', () => {
        delete process.env.FACTORY_TASK_ID
        const active = resolveActiveTask(run({t1: task({status: 'executing', phase: 'tests'})}))
        expect(active?.phase).toBe('tests')
    })

    it('single reviewing task → its cursor phase', () => {
        delete process.env.FACTORY_TASK_ID
        const active = resolveActiveTask(run({t1: task({status: 'reviewing', phase: 'verify'})}))
        expect(active?.phase).toBe('verify')
    })

    it('single shipping task → its cursor phase', () => {
        delete process.env.FACTORY_TASK_ID
        const active = resolveActiveTask(run({t1: task({status: 'shipping', phase: 'ship'})}))
        expect(active?.phase).toBe('ship')
    })

    it('ambiguous (two in-flight, no explicit id) → null', () => {
        delete process.env.FACTORY_TASK_ID
        const active = resolveActiveTask(
            run({
                t1: task({task_id: 't1', status: 'executing', phase: 'tests'}),
                t2: task({task_id: 't2', status: 'reviewing', phase: 'verify'}),
            })
        )
        expect(active).toBeNull()
    })

    it('explicit task id selects even amid ambiguity', () => {
        delete process.env.FACTORY_TASK_ID
        const active = resolveActiveTask(
            run({
                t1: task({task_id: 't1', status: 'executing', phase: 'tests'}),
                t2: task({task_id: 't2', status: 'reviewing', phase: 'verify'}),
            }),
            't2'
        )
        expect(active?.task.task_id).toBe('t2')
        expect(active?.phase).toBe('verify')
    })

    it('explicit id absent from run → null (no fabrication)', () => {
        delete process.env.FACTORY_TASK_ID
        expect(resolveActiveTask(run({t1: task()}), 'nope')).toBeNull()
    })

    it('no in-flight task → null', () => {
        delete process.env.FACTORY_TASK_ID
        expect(resolveActiveTask(run({t1: task({status: 'done'})}))).toBeNull()
    })
})

describe('resolveActiveTask phase source', () => {
    const origTaskId = process.env.FACTORY_TASK_ID
    afterEach(() => {
        if (origTaskId === undefined) {
            delete process.env.FACTORY_TASK_ID
        } else {
            process.env.FACTORY_TASK_ID = origTaskId
        }
    })

    it('an exec cursor on an executing row keeps the test-writer guard off (exec window)', () => {
        // status "executing" with an `exec` cursor is the GREEN window —
        // the test-writer guard must NOT fire.
        const active = resolveActiveTask(
            run({t1: task({status: 'executing', phase: 'exec', producer_role: 'test-writer'})}),
            't1'
        )
        expect(active?.phase).toBe('exec')
        expect(isTestWriterPhase(active)).toBe(false)
    })

    it('terminal/pending stays null even with a stale cursor on the row', () => {
        // terminal rows keep the LAST in-flight phase as history — never an active phase.
        delete process.env.FACTORY_TASK_ID
        expect(resolveActiveTask(run({t1: task({status: 'done', phase: 'ship'})}))).toBeNull()
    })

    it('explicit id on a terminal row → phase null despite the stale cursor', () => {
        const active = resolveActiveTask(run({t1: task({status: 'done', phase: 'ship'})}), 't1')
        expect(active).not.toBeNull()
        expect(active?.phase).toBeNull()
    })

    it('tests-phase cursor keeps the test-writer guard active', () => {
        const active = resolveActiveTask(
            run({t1: task({status: 'executing', phase: 'tests', producer_role: 'test-writer'})}),
            't1'
        )
        expect(isTestWriterPhase(active)).toBe(true)
    })

    it('pending row with a preflight cursor resolves null (the orchestrator writes pending+preflight at entry)', () => {
        delete process.env.FACTORY_TASK_ID
        const r = run({t1: task({status: 'pending', phase: 'preflight'})})
        expect(resolveActiveTask(r)).toBeNull()
    })
})

describe('isTestWriterPhase', () => {
    it('executing tests-phase + test-writer role → true', () => {
        const active = resolveActiveTask(
            run({t1: task({status: 'executing', phase: 'tests', producer_role: 'test-writer'})}),
            't1'
        )
        expect(isTestWriterPhase(active)).toBe(true)
    })

    it('executing + implementer role → false (GREEN phase, not test-writer)', () => {
        const active = resolveActiveTask(
            run({t1: task({status: 'executing', phase: 'exec', producer_role: 'implementer'})}),
            't1'
        )
        expect(isTestWriterPhase(active)).toBe(false)
    })

    it('reviewing → false', () => {
        const active = resolveActiveTask(run({t1: task({status: 'reviewing', phase: 'verify'})}), 't1')
        expect(isTestWriterPhase(active)).toBe(false)
    })

    it('null active → false', () => {
        expect(isTestWriterPhase(null)).toBe(false)
    })
})

// --- worktree path → run+task ownership (run-isolation L1.1) -----------------

describe('runTaskForPath — derive owning run+task from a producer write path', () => {
    let dataDir: string
    beforeEach(() => {
        dataDir = mkdtempSync(join(tmpdir(), 'rtfp-'))
    })
    afterEach(() => {
        rmSync(dataDir, {recursive: true, force: true})
    })

    it('a file under worktrees/<run>/<task>/… resolves both ids', () => {
        const p = join(worktreesRoot(dataDir), 'run-20260101-000000', 't1', 'src', 'a.ts')
        expect(runTaskForPath(dataDir, p)).toEqual({
            run_id: 'run-20260101-000000',
            task_id: 't1',
        })
    })

    it('the task dir itself (no file tail) still resolves both ids', () => {
        const p = join(worktreesRoot(dataDir), 'run-x', 't2')
        expect(runTaskForPath(dataDir, p)).toEqual({run_id: 'run-x', task_id: 't2'})
    })

    it('a path under worktrees/<run> with no task segment → null', () => {
        const p = join(worktreesRoot(dataDir), 'run-x')
        expect(runTaskForPath(dataDir, p)).toBeNull()
    })

    it('a path in an unrelated repo checkout → null (the spurious-block fix)', () => {
        expect(runTaskForPath(dataDir, '/Users/dev/some-repo/src/index.ts')).toBeNull()
    })

    it('a path under runs/ (a sibling store, not a worktree) → null', () => {
        const p = join(dataDir, 'runs', 'run-x', 'state.json')
        expect(runTaskForPath(dataDir, p)).toBeNull()
    })

    it('a traversal out of a worktree resolves away and does NOT match', () => {
        // worktrees/run-x/t1/../../../etc/passwd canonicalizes above the root → null.
        const p = join(worktreesRoot(dataDir), 'run-x', 't1', '..', '..', '..', 'etc', 'passwd')
        expect(runTaskForPath(dataDir, p)).toBeNull()
    })

    it('canonicalizes a symlinked dataDir on both sides (consistent match)', () => {
        // mkdtemp on macOS lives under a symlinked /var → /private/var; canonicalizePath
        // realpaths both the root and the candidate, so the under-root check still holds.
        const p = join(worktreesRoot(dataDir), 'run-y', 't3', 'pkg', 'b.ts')
        expect(runTaskForPath(dataDir, p)).toEqual({run_id: 'run-y', task_id: 't3'})
    })

    it('a segment that is not a valid id → null (not a recognizable worktree path)', () => {
        const p = join(worktreesRoot(dataDir), 'bad id with spaces', 't1', 'a.ts')
        expect(runTaskForPath(dataDir, p)).toBeNull()
    })

    it('empty dataDir or empty path → null', () => {
        expect(runTaskForPath('', '/x')).toBeNull()
        expect(runTaskForPath(dataDir, '')).toBeNull()
    })
})
