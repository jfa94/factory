/**
 * WS9 — PreToolUse Bash guard: block destructive git ops on protected branches.
 *
 * Real implementation (replaces the WS0 no-op stub). Ports
 * `hooks/branch-protection.sh` onto the typed seam: the git-invocation parser
 * lives in {@link parseGitInvocation} (git-args.ts), current-branch resolution
 * goes through the INJECTABLE exec seam (`git symbolic-ref`), and the
 * nested-shell/hook-bypass denial is the shared {@link isNestedShellOrHookBypass}.
 *
 * Blocks (each a "documented invocation form" the bash parser handled):
 *   1. implicit push while standing on a protected branch
 *   2. force-push (--force/-f/--force-with-lease/--force-if-includes) to protected
 *   3. +refspec force-push to protected
 *   4. plain `git push <remote> <protected>` (or HEAD:<protected>)
 *   5. `git push <remote> --delete <protected>`
 *   6. `git reset --hard` while ON a protected branch
 *   7. `git branch -D/-d/--delete <protected>`
 *
 * Exception: the pipeline-managed `staging` branch is writable, but ONLY inside
 * an orchestrator worktree (cwd under `.claude/worktrees/orchestrator-*`) — the
 * serial writer merges task PRs into staging there.
 */
import {EXIT, type ExitCode} from '../shared/exit-codes.js'
import {exec as defaultExec, type ExecResult} from '../shared/exec.js'
import {createLogger} from '../shared/index.js'
import {parseGitInvocation, type GitInvocation} from './git-args.js'
import {isNestedShellOrHookBypass} from './shell-bypass.js'
import {isAutonomous} from '../autonomy/mode.js'
import {
    allow,
    commandOf,
    deny,
    decisionToExitCode,
    emitPermissionDecision,
    parseHookInput,
    type HookDecision,
    type HookInput,
} from './hook-io.js'

/** The protected-branch set (hardcoded — a destructive op on any is denied). */
export const PROTECTED_BRANCHES: readonly string[] = [
    'main',
    'master',
    'develop',
    'staging',
    'production',
    'release',
    'prod',
]

/** Pipeline-managed branches writable from an orchestrator worktree. */
export const PIPELINE_MANAGED_BRANCHES: readonly string[] = ['staging']

const log = createLogger('branch-protection')

/** A function that resolves the current branch for a repo (injectable). */
export type CurrentBranchResolver = (inv: GitInvocation) => Promise<string>

/** Options for {@link runBranchProtectionDecision} (everything injectable). */
export interface BranchProtectionDeps {
    /** The shell exec seam (defaults to the real one). */
    exec?: ((command: string, args?: readonly string[], opts?: {cwd?: string}) => Promise<ExecResult>) | undefined
    /** Override current-branch resolution entirely (tests). */
    resolveCurrentBranch?: CurrentBranchResolver
    /** cwd used for the orchestrator-worktree exception (defaults to process.cwd()). */
    cwd?: string
    /** Whether autonomous mode is active (defaults to FACTORY_AUTONOMOUS_MODE === "1"). */
    autonomousMode?: boolean
}

/** Is `name` a protected branch? */
export function isProtectedBranch(name: string): boolean {
    return PROTECTED_BRANCHES.includes(name)
}

/** Is cwd inside an orchestrator worktree (`.claude/worktrees/orchestrator-*`)? */
function inOrchestratorWorktree(cwd: string): boolean {
    return cwd.includes('/.claude/worktrees/orchestrator-')
}

/**
 * May the pipeline write the given protected branch? Only when (a) autonomous
 * mode is on, (b) the branch is pipeline-managed (`staging`), and (c) cwd is in
 * an orchestrator worktree. Mirrors the bash `_pipeline_can_write`.
 */
function pipelineCanWrite(branch: string, cwd: string, autonomousMode: boolean): boolean {
    if (!autonomousMode) {
        return false
    }
    if (!PIPELINE_MANAGED_BRANCHES.includes(branch)) {
        return false
    }
    return inOrchestratorWorktree(cwd)
}

/** Default current-branch resolver: `git [-C dir] [--git-dir d] symbolic-ref --short HEAD`. */
function makeDefaultResolver(execFn: NonNullable<BranchProtectionDeps['exec']>): CurrentBranchResolver {
    return async (inv: GitInvocation): Promise<string> => {
        const args: string[] = []
        if (inv.workDir) {
            args.push('-C', inv.workDir)
        }
        if (inv.gitDir) {
            args.push('--git-dir', inv.gitDir)
        }
        args.push('symbolic-ref', '--short', 'HEAD')
        try {
            const r = await execFn('git', args, {})
            if (r.code === 0) {
                return r.stdout.trim()
            }
            // Non-zero exit (notably 128 on a detached HEAD): git ran fine but there is
            // no symbolic current branch. Expected and benign — no branch to protect, so
            // treat as unprotected SILENTLY (warning here would be noise on every
            // detached-HEAD op).
            return ''
        } catch (err) {
            // A THROWN error is NOT a detached HEAD (that is the non-zero exit handled
            // above) — it means the resolver itself could not run: git missing (ENOENT),
            // permission denied (EACCES), or a spawn failure. We still fail open (an
            // unresolvable branch cannot be proven protected), but LOUDLY: warn so a push
            // that silently skipped the protected-branch guard is detectable.
            log.warn(
                `current-branch resolution failed (${(err as Error).message}); ` +
                    `treating as unprotected — a protected-branch guard may not apply`
            )
            return ''
        }
    }
}

/**
 * Compute the branch-protection decision for a parsed hook input. Pure-ish: the
 * only side effect is the injected current-branch resolver (exec seam). Returns
 * a {@link HookDecision} so it is directly unit-testable.
 */
export async function decideBranchProtection(
    input: HookInput | null,
    deps: BranchProtectionDeps = {}
): Promise<HookDecision> {
    const command = commandOf(input)
    if (command.length === 0) {
        return allow()
    }

    const cwd = deps.cwd ?? process.cwd()
    const autonomousMode = deps.autonomousMode ?? isAutonomous()

    // Nested-shell / hook-bypass denial — AUTONOMOUS MODE ONLY, by design (a faithful
    // port of the bash hook, NOT an oversight). A nested shell (`bash -c …`, `sh -c …`)
    // or hook-bypass is a legitimate, everyday tool in a HUMAN dev session, so denying it
    // there would be a constant false-positive. It is a risk only in an UNATTENDED run,
    // where it is the canonical way to smuggle a git write past the parsed-command guards
    // below. Hence the gate is scoped to autonomousMode. See Decision 12 (and the
    // branch-protection note in docs/explanation/decisions.md).
    if (autonomousMode && isNestedShellOrHookBypass(command)) {
        return deny('nested_shell_denied', `nested-shell or hook-bypass not allowed in autonomous mode: ${command}`)
    }

    const inv = parseGitInvocation(command)
    if (inv.subcommand === null) {
        return allow()
    }

    const execFn = deps.exec ?? defaultExec
    const resolveCurrent = deps.resolveCurrentBranch ?? makeDefaultResolver(execFn)

    // --- Check 1: implicit push while on a protected branch ---
    if (inv.subcommand === 'push') {
        const current = await resolveCurrent(inv)
        if (current.length > 0 && isProtectedBranch(current)) {
            if (inv.destBranch.length === 0 || inv.destBranch === current) {
                if (!pipelineCanWrite(current, cwd, autonomousMode)) {
                    return deny('on_protected_branch', `currently on '${current}' — push will publish to protected`)
                }
            }
        }
    }

    // --- Check 2: force-push to a protected target ---
    if (inv.subcommand === 'push' && inv.isForce) {
        if (inv.destBranch.length > 0 && isProtectedBranch(inv.destBranch)) {
            return deny('force_push_protected', `force-push targets protected branch '${inv.destBranch}'`)
        }
    }

    // --- Check 3: +refspec force-push to a protected branch ---
    if (inv.subcommand === 'push' && inv.isPlusRef) {
        if (inv.destBranch.length > 0 && isProtectedBranch(inv.destBranch)) {
            return deny(
                'force_push_refspec_protected',
                `+refspec force-push targets protected branch '${inv.destBranch}'`
            )
        }
    }

    // --- Check 4: plain push to a protected branch ---
    if (inv.subcommand === 'push') {
        if (inv.destBranch.length > 0 && isProtectedBranch(inv.destBranch)) {
            if (!pipelineCanWrite(inv.destBranch, cwd, autonomousMode)) {
                return deny('push_to_protected', `push targets protected branch '${inv.destBranch}'`)
            }
        }
    }

    // --- Check 5: remote delete of a protected branch ---
    if (inv.subcommand === 'push' && inv.namedArg.length > 0) {
        if (isProtectedBranch(inv.namedArg)) {
            return deny('remote_delete_protected', `remote deletion of protected branch '${inv.namedArg}'`)
        }
    }

    // --- Check 6: hard reset while ON a protected branch ---
    if (inv.subcommand === 'reset' && inv.isHardReset) {
        const current = await resolveCurrent(inv)
        if (current.length > 0 && isProtectedBranch(current)) {
            if (!pipelineCanWrite(current, cwd, autonomousMode)) {
                return deny('hard_reset_on_protected', `hard reset while on protected branch '${current}'`)
            }
        }
    }

    // --- Check 7: local delete of a protected branch ---
    if (inv.subcommand === 'branch' && inv.namedArg.length > 0) {
        if (isProtectedBranch(inv.namedArg)) {
            return deny('delete_protected_branch', `deletion of protected branch '${inv.namedArg}'`)
        }
    }

    return allow()
}

/**
 * Run the branch-protection guard end-to-end: read+parse stdin, decide, emit the
 * permission-decision JSON on a deny, return the exit code. Malformed stdin fails
 * closed (deny). `_argv` is the dispatcher's remaining args (unused).
 *
 * Injectable `readRaw` (stdin reader) for tests.
 */
export async function runBranchProtection(
    _argv: string[] = [],
    deps: BranchProtectionDeps & {readRaw?: () => Promise<string>} = {}
): Promise<ExitCode> {
    let input: HookInput | null
    try {
        const raw = deps.readRaw ? await deps.readRaw() : await readAllStdin()
        input = parseHookInput(raw)
    } catch {
        // Malformed input → fail closed (deny).
        const decision = deny('malformed_hook_input', 'branch-protection: unparseable hook input')
        emitPermissionDecision(decision)
        return EXIT.ERROR
    }
    const decision = await decideBranchProtection(input, deps)
    emitPermissionDecision(decision)
    return decisionToExitCode(decision)
}

/** Read all of process.stdin as utf-8 (the production stdin reader). */
async function readAllStdin(): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array))
    }
    return Buffer.concat(chunks).toString('utf8')
}
