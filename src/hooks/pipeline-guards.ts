/**
 * WS9 — PreToolUse guard for factory pipeline invariants, RE-TARGETED to the new
 * seam (ports `hooks/pretooluse-pipeline-guards.sh`).
 *
 * Each arm derives its OWNING run from its own inputs — no arm reads a single
 * global pointer, so the guard fires only for the run a given tool call belongs to
 * (enabling concurrent cross-repo runs). Three invariants:
 *   (a) TEST-WRITER PHASE scope: while the owning task's phase is `tests`, an
 *       Edit/Write/MultiEdit to a NON-test path is blocked (the test-writer may
 *       commit only failing tests first — TDD). The owning run+task is derived from
 *       the TARGET PATH (the per-task worktree the producer writes into), so an
 *       unrelated session's edit elsewhere never trips it.
 *   (b) NESTED-SHELL / hook-bypass denial while THIS session's run is active
 *       (owner-scoped via {@link loadOwnerScopedRun}; shared {@link isNestedShellOrHookBypass}).
 *   (c) SHIP guard (agent-deny): `gh pr create`/`gh pr merge` are categorically
 *       denied while a run is active. The factory ENGINE opens and merges PRs
 *       deterministically from inside `factory next-action` (a child_process `gh` call
 *       that never transits this Bash-tool hook — src/orchestrator/ship.ts), and the
 *       merge gate that actually gates shipping is derived THERE
 *       (derive-don't-store). So any ship command reaching this hook is an
 *       agent-initiated attempt, which the boundary simply refuses — there is no
 *       merge gate to re-derive here.
 *
 * A corrupt run state (or broken git env) fails CLOSED (deny) — corruption is never
 * silently allowed. No active run → pass through.
 */
import {join} from 'node:path'
import {EXIT, type ExitCode} from '../shared/exit-codes.js'
import {isTestPath} from '../verifier/deterministic/scope.js'
import {StateManager} from '../core/state/index.js'
import {TaskPhaseEnum} from '../core/phase-machine/index.js'
import {
    loadOwnerScopedRun,
    resolveActiveTask,
    isTestWriterPhase,
    runTaskForPath,
    type ActiveRun,
    type OwnerScopedRunOptions,
} from './hook-context.js'
import {isNestedShellOrHookBypass} from './shell-bypass.js'
import {resolveDataDir, type DataDirOptions} from '../config/load.js'
import {DefaultGitClient, type GitClient} from '../git/index.js'
import type {RunState} from '../types/index.js'
import {
    allow,
    commandOf,
    deny,
    decisionToExitCode,
    emitPermissionDecision,
    filePathsOf,
    parseHookInput,
    toolNameOf,
    type HookDecision,
    type HookInput,
    readStdin,
} from './hook-io.js'

/** Options for {@link decidePipelineGuards} (injectable). */
export interface PipelineGuardsDeps extends DataDirOptions {
    cwd?: string
    /** Override the active-run loader for the Bash arms (tests). */
    loadRun?: (opts: OwnerScopedRunOptions) => Promise<ActiveRun | null>
    /**
     * Override the per-run-id loader for the path-anchored write-scope arm (tests).
     * Defaults to `StateManager.read` under the resolved data dir; THROWS (ENOENT /
     * schema error) for a missing/corrupt run, which the arm maps to a fail-closed deny.
     */
    loadRunById?: (dataDir: string, runId: string) => Promise<RunState>
    /**
     * Test seam for the write-scope arm's `mainWorktreeRoot()` resolution. Mirrors
     * the existing injectable-client convention ({@link OwnerScopedRunOptions.gitClient}).
     * Defaults to {@link DefaultGitClient}.
     */
    gitClient?: GitClient
}

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

// The test-path classification (write-scope arm) shares the verifier's single
// source of truth ({@link isTestPath} in verifier/deterministic/scope.ts) so the
// hook's RED-phase write gate and the TDD gate's commit classification AGREE on
// what counts as a test file — a prior local copy diverged (narrower) and would
// wrongly block test-writer writes in Go/Ruby/alt-layout repos.

// Boundary-aware so a prefixed/compound command cannot evade the ship gate:
// `cd /r && gh pr create`, `true; gh pr create`, `GH=1 gh pr create`, `a | gh …`
// all match. Mirrors the sibling guards' boundary discipline (secret/holdout)
// rather than the anchor-only `^\s*` which only catches a bare leading command.
// Fail-closed: a harmless `echo gh pr create` also matches, which is the safe
// direction for a deny-gate.
const GH_PR_CREATE_RE = /(^|[\s&;|(])gh\s+pr\s+create\b/
const GH_PR_MERGE_RE = /(^|[\s&;|(])gh\s+pr\s+merge\b/

/** Detect a `gh pr create` command (anywhere in a compound command). */
function isGhPrCreate(cmd: string): boolean {
    return GH_PR_CREATE_RE.test(cmd)
}
/** Detect a `gh pr merge` command (anywhere in a compound command). */
function isGhPrMerge(cmd: string): boolean {
    return GH_PR_MERGE_RE.test(cmd)
}

/**
 * Cheap, path-aware pre-filter: does `p` contain a `.claude` segment immediately
 * followed by a `worktrees` segment? NOT a naive substring match (a sibling dir
 * like `.claude-worktrees-backup` must not match) and tolerant of either path
 * separator, so it stays correct on Windows regardless of which form the hook
 * payload's `file_path` arrives in.
 */
function isPlausiblyUnderClaudeWorktrees(p: string): boolean {
    const segments = p.split(/[/\\]/)
    for (let i = 0; i + 1 < segments.length; i++) {
        if (segments[i] === '.claude' && segments[i + 1] === 'worktrees') {
            return true
        }
    }
    return false
}

/**
 * The test-writer write-scope arm, anchored to the target path. For each write
 * target that lands inside a per-task worktree (`<workDir>/<run>/<task>`, where
 * `workDir` is `<main-repo-root>/.claude/worktrees` — the protected-path
 * exemption, Decision 67), resolve the owning run+task FROM THE PATH and deny a
 * non-test write while that task is in the test-writer phase. Returns a deny
 * {@link HookDecision}, or `null` when nothing in scope warrants a deny (no
 * worktree match, or not the RED phase).
 *
 * Pre-filters on the target path BEFORE any git call or `resolveDataDir` — this
 * hook fires on EVERY Edit/Write/MultiEdit system-wide, so the overwhelmingly
 * common case (no target anywhere near `.claude/worktrees/`) now costs one path
 * split instead of an unconditional `resolveDataDir`.
 *
 * Fail-closed: a target inside a worktree whose data dir or run state cannot be
 * resolved denies (corruption/misconfiguration is never silently allowed). A
 * target outside every worktree is not a producer write → no scope.
 */
async function decideWriteScope(input: HookInput | null, deps: PipelineGuardsDeps): Promise<HookDecision | null> {
    const targets = filePathsOf(input)
    if (targets.length === 0 || !targets.some(isPlausiblyUnderClaudeWorktrees)) {
        return null
    }

    const gitClient = deps.gitClient ?? new DefaultGitClient()
    const cwd = deps.cwd ?? input?.cwd
    let workDir: string
    try {
        workDir = join(await gitClient.mainWorktreeRoot(cwd !== undefined ? {cwd} : {}), '.claude', 'worktrees')
    } catch {
        return null // not inside a resolvable git repo → no worktree → nothing to scope
    }

    const loadRunById =
        deps.loadRunById ?? ((dir: string, runId: string) => new StateManager({...deps, dataDir: dir}).read(runId))

    for (const target of targets) {
        const ref = runTaskForPath(workDir, target)
        if (ref === null) {
            continue
        } // not a producer-worktree write → no scope

        // Run STATE lives in the plugin data dir, not workDir — resolve it only now
        // that a target has positively matched a real factory worktree. Unlike the
        // pre-filter above (a plain pass-through), an unresolvable data dir HERE
        // means a write we know targets a factory worktree can't be scope-checked
        // → fail closed rather than silently letting it through.
        let dataDir: string
        try {
            dataDir = resolveDataDir(deps)
        } catch {
            return deny(
                'test_writer_scope_broken',
                `write to '${target}' resolves to run '${ref.run_id}' / task '${ref.task_id}', ` +
                    `but the plugin data dir cannot be resolved; failing closed.`
            )
        }

        let run: RunState
        try {
            run = await loadRunById(dataDir, ref.run_id)
        } catch {
            // The path names a worktree but its run state cannot be read → fail closed.
            return deny(
                'test_writer_scope_broken',
                `write to '${target}' resolves to run '${ref.run_id}' / task '${ref.task_id}', ` +
                    `whose run state is missing or corrupt; failing closed.`
            )
        }

        const activeTask = resolveActiveTask(run, ref.task_id)
        if (isTestWriterPhase(activeTask) && !isTestPath(target)) {
            return deny(
                'test_writer_scope',
                `Test-writer phase: only test files allowed. Detected write to '${target}'. ` +
                    `Move implementation code to the GREEN (exec) phase.`
            )
        }
    }
    return null
}

/**
 * Decide the pipeline-invariant verdict for a hook input. The write-scope arm is
 * path-anchored (per-run read); the Bash arms resolve the active run. A throwing
 * loader (corrupt state.json, broken git env) is mapped to a fail-closed deny by
 * the caller — this function rethrows so the loud failure is visible;
 * {@link runPipelineGuards} catches it.
 */
export async function decidePipelineGuards(
    input: HookInput | null,
    deps: PipelineGuardsDeps = {}
): Promise<HookDecision> {
    const tool = toolNameOf(input)
    const cmd = commandOf(input)

    // (a) test-writer-phase write-scope — anchored to the TARGET PATH, not a global
    // pointer. A producer writes into its own `<workDir>/<run>/<task>` (workDir =
    // `<main-repo-root>/.claude/worktrees`, Decision 67), so the write path itself
    // names the owning run+task; an unrelated session's edit to any other checkout
    // resolves to no run → this arm does not fire.
    if (WRITE_TOOLS.has(tool)) {
        const scoped = await decideWriteScope(input, deps)
        if (scoped !== null) {
            return scoped
        } // deny; null = no worktree scope, fall through
    }

    // (b)+(c) Bash arms resolve the run owning THIS session. No Bash command → nothing to gate.
    if (cmd.length === 0) {
        return allow()
    }

    // Resolve the run owned by THIS session (env-scoped); when the session id is
    // unavailable, fall back to the invoking cwd's per-repo current run, else the
    // newest non-terminal run (see loadOwnerScopedRun's 3-tier order). The cwd comes
    // from deps or the hook payload CC pipes in.
    const loadRun = deps.loadRun ?? loadOwnerScopedRun
    const cwd = deps.cwd ?? input?.cwd
    const active = await loadRun({...deps, ...(cwd !== undefined ? {cwd} : {})})
    if (active === null) {
        return allow()
    } // no run owned by this session → pass through

    // (b) nested-shell / hook-bypass while a run is active.
    if (isNestedShellOrHookBypass(cmd)) {
        return deny(
            'nested_shell_denied',
            `nested-shell or hook-bypass not allowed while a pipeline run is active: ${cmd}`
        )
    }

    // (c) SHIP guard — agent-deny. The factory engine ships deterministically from
    // INSIDE `factory next-action` (a child_process `gh` call that never transits this
    // Bash-tool hook — src/orchestrator/ship.ts), so any `gh pr create`/`gh pr merge` that
    // DOES reach this hook is an agent-initiated ship attempt while a run is active.
    // That is categorically denied: PRs are opened and merged ONLY by the engine,
    // whose merge gate gates shipping (derive-don't-store) — there is nothing to
    // re-derive here, just a security boundary to hold.
    if (tool === 'Bash' && (isGhPrCreate(cmd) || isGhPrMerge(cmd))) {
        const op = isGhPrCreate(cmd) ? 'gh pr create' : 'gh pr merge'
        return deny(
            'ship_agent_denied',
            `agent-initiated '${op}' is not allowed while a pipeline run is active: ` +
                `the factory engine opens and merges PRs deterministically, never an agent.`
        )
    }

    return allow()
}

/**
 * Run the pipeline-invariant guard end-to-end. A corrupt run state or malformed
 * stdin fails CLOSED (deny). Injectable `readRaw` for tests.
 */
export async function runPipelineGuards(
    _argv: string[] = [],
    deps: PipelineGuardsDeps & {readRaw?: () => Promise<string>} = {}
): Promise<ExitCode> {
    let input: HookInput | null
    try {
        const raw = deps.readRaw ? await deps.readRaw() : await readStdin()
        input = parseHookInput(raw)
    } catch {
        const decision = deny('malformed_hook_input', 'pipeline-guards: unparseable hook input')
        emitPermissionDecision(decision)
        return EXIT.ERROR
    }
    let decision: HookDecision
    try {
        decision = await decidePipelineGuards(input, deps)
    } catch (err) {
        // Corrupt state.json behind a live pointer, a broken git env, or any other
        // loud failure → fail closed (deny).
        decision = deny('pipeline_guard_error', (err as Error).message)
        emitPermissionDecision(decision)
        return EXIT.ERROR
    }
    emitPermissionDecision(decision)
    return decisionToExitCode(decision)
}

/** Re-export for phase identification in callers/tests. */
export {TaskPhaseEnum}
