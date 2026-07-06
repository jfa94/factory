/**
 * Resolve the run that is "current" FOR THE REPO OF THE CALLER'S CHECKOUT
 * (run-isolation L2.8). The human-facing read commands (`state`, `score`, `rescue`,
 * `run resume`/`finalize`) default to this when no `--run` is given, so two runs
 * live in two different checkouts each resolve their OWN run — never whichever one
 * happened to repoint the global pointer last.
 *
 * Repo resolution mirrors `run create`'s {@link RunCreateOverrides} seam exactly:
 * derive `owner/name` from the `origin` remote of `cwd` via {@link resolveRepo}, with
 * the git client + cwd injectable for tests. When the repo is NOT derivable (invoked
 * outside any checkout / no `origin`), there is no current run for the caller —
 * resolve to null and let the command's own "no current run" handling speak. The
 * global repo-less `runs/current` pointer stays for no-cwd consumers (statusline
 * ticks, hook-context) — it is just never a fallback here.
 *
 * NOTE this is intentionally NOT used by `factory next-task`: that command is machine-driven
 * (the runner bootstrap), always passes `--run` on the hot path, and its
 * no-`--run` fallback is guarded against a foreign run by `--assert-owner`.
 */
import {DefaultGitClient, resolveRepo, type GitClient} from '../git/index.js'
import type {RunState, StateManager} from '../core/state/index.js'

/** Test seam: inject the git client + cwd (parity with {@link RunCreateOverrides}). */
export interface CurrentRunOverrides {
    readonly gitClient?: GitClient
    readonly cwd?: string
}

/**
 * The current run for the caller's checkout, or `null` when none. Resolves the repo
 * from `cwd`'s `origin` remote and reads that repo's pointer; an underivable repo
 * (not a checkout / no origin) means no current run. Never throws on repo resolution.
 */
export async function readCurrentForCwd(
    state: StateManager,
    overrides: CurrentRunOverrides = {}
): Promise<RunState | null> {
    const cwd = overrides.cwd ?? process.cwd()
    const gitClient = overrides.gitClient ?? new DefaultGitClient()
    let repo: string
    try {
        repo = await resolveRepo({cwd, gitClient})
    } catch {
        // Not a checkout / no origin remote → no repo, no current run.
        return null
    }
    return state.readCurrentForRepo(repo)
}
