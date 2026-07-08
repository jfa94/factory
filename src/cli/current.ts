/**
 * Resolve the run that is "current" FOR THE REPO OF THE CALLER'S CHECKOUT
 * (run-isolation L2.8). Every default-to-current command — the human-facing reads
 * (`state`, `score`, `rescue`, `run resume`/`finalize`) AND the machine-driven
 * `factory next-task` — resolves through here when no `--run` is given, so two runs
 * living in two different checkouts each resolve their OWN run. This is now the ONLY
 * current-run resolution path: the global repo-less `runs/current` pointer was
 * retired (Decision 61), so there is no last-writer-wins global fallback to race.
 *
 * Repo resolution mirrors `run create`'s {@link RunCreateOverrides} seam exactly:
 * derive `owner/name` from the `origin` remote of `cwd` via {@link resolveRepo}, with
 * the git client + cwd injectable for tests. When the repo is NOT derivable (invoked
 * outside any checkout / no `origin`), there is no current run for the caller —
 * resolve to null and let the command's own "no current run" handling speak.
 */
import {DefaultGitClient, resolveRepo, type GitClient} from '../git/index.js'
import {optionalString, UsageError, type ParsedArgs} from './args.js'
import type {RunState, StateManager} from '../core/state/index.js'

/** Test seam: inject the git client + cwd (parity with {@link RunCreateOverrides}). */
export interface CurrentRunOverrides {
    readonly gitClient?: GitClient
    readonly cwd?: string
}

/**
 * The current run for the caller's checkout, or `null` when none. Resolves the repo
 * from `cwd`'s `origin` remote and reads that repo's pointer; an underivable repo
 * (not a checkout / no origin, a `UsageError`) means no current run. Any other
 * resolution failure (broken git env) is rethrown.
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
    } catch (err) {
        // Not a checkout / no origin remote → no repo, no current run. Only the
        // EXPECTED negatives (resolveRepo's own UsageErrors) mean that; anything
        // else (broken git env) must surface, not masquerade as "no current run".
        if (err instanceof UsageError) {
            return null
        }
        throw err
    }
    return state.readCurrentForRepo(repo)
}

/**
 * Resolve `runId` from `--run`, falling back to the caller-repo current run (LOUD
 * if neither is available) — the shared head of every command that defaults to the
 * active run (`resume`/`finalize`/phase commands, `rescue apply`/`auto`). `label`
 * is the error-message prefix (e.g. `run finalize`, `rescue apply`).
 */
export async function resolveRunIdOrCurrent(
    state: StateManager,
    args: ParsedArgs,
    label: string,
    overrides: CurrentRunOverrides = {}
): Promise<string> {
    const explicit = optionalString(args.flag('run'))
    if (explicit !== undefined) {
        return explicit
    }
    const current = await readCurrentForCwd(state, overrides)
    if (current === null) {
        throw new UsageError(`${label}: no --run given and no current run`)
    }
    return current.run_id
}
