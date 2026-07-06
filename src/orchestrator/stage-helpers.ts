/**
 * Shared plumbing for the run-level stages (docs, traceability, assessment, e2e).
 *
 * Each stage keeps its OWN coroutine, cap policy, and attempt accounting — the
 * shared parts are exactly the mechanics that were copy-pasted: the idempotent
 * worktree prep, the ff-merge→push publish, the prompt's spec-task lines, and the
 * spawn/terminal envelope base shapes (types only — emit sites keep their object
 * literals, so the JSON wire format is untouched).
 *
 * Leaf like `e2e-paths.ts`: type-only import from `./deps.js`, no runtime deps.
 */
import type {GitClient, SpecManifest} from './deps.js'

/** The common head of every stage spawn envelope. */
export interface StageSpawnBase {
    readonly run_id: string
    /** The runner-facing `Task(subagent_type)` value, spawned verbatim (C4). */
    readonly agent_type: string
    readonly worktree: string
    readonly staging_branch: string
    readonly model: string
    readonly max_turns: number
    readonly prompt: string
}

export interface StageDone {
    readonly kind: 'done'
    readonly run_id: string
}

export interface StageFailed {
    readonly kind: 'failed'
    readonly run_id: string
    readonly reason: string
}

export interface StageSuspend {
    readonly kind: 'suspend'
    readonly run_id: string
    readonly reason: string
}

/** Options for {@link ensureStageWorktree}. */
export interface EnsureStageWorktreeOptions {
    readonly worktree: string
    /** The ref the worktree is cut from / reset to (e.g. `origin/<staging>`). */
    readonly ref: string
    /** Branch to (re)create at `ref`; omitted → `--detach` (read-only stages). */
    readonly branch?: string
    /** Reset an EXISTING worktree hard to `ref` (retry hygiene); false leaves it as-is. */
    readonly resetIfExists: boolean
    /** Run after CREATE only (never on reuse) — e.g. dependency provisioning. */
    readonly provision?: () => Promise<void>
}

/**
 * Idempotent stage-worktree prep. Absent → create (+ provision); present →
 * `resetHardClean(ref)` iff `resetIfExists`. `git fetch` stays at call sites
 * (stages genuinely differ in what they fetch).
 *
 * `-B` (not `-b`): a crash between the stage's worktree removal and its
 * concluding state write can leave the branch behind after the worktree path is
 * gone — a bare `-b` would fatal on re-entry, wedging the stage before its
 * RECORD-side attempt cap can fire. `-B` force-creates/resets either way.
 */
export async function ensureStageWorktree(git: GitClient, opts: EnsureStageWorktreeOptions): Promise<void> {
    if (!(await git.worktreeExists(opts.worktree))) {
        const args =
            opts.branch !== undefined
                ? ['-B', opts.branch, opts.worktree, opts.ref]
                : ['--detach', opts.worktree, opts.ref]
        await git.worktreeAdd(args)
        if (opts.provision !== undefined) {
            await opts.provision()
        }
    } else if (opts.resetIfExists) {
        await git.resetHardClean(opts.ref, {cwd: opts.worktree})
    }
}

/**
 * Publish a stage branch onto staging: ff-merge (or merge-commit fallback) then
 * push. `worktreeRemove` stays at call sites — its placement differs per stage.
 */
export async function publishToStaging(git: GitClient, staging: string, branch: string): Promise<void> {
    await git.mergeFfOrCommit(staging, branch)
    await git.push('origin', staging)
}

/** One prompt line per spec task: `  - <id> — <title>: <criteria; …>`. */
export function specTaskLines(spec: SpecManifest): string {
    return spec.tasks.map((t) => `  - ${t.task_id} — ${t.title}: ${t.acceptance_criteria.join('; ')}`).join('\n')
}
