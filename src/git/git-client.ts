/**
 * Typed GitClient over an injectable {@link GitRunner}.
 *
 * The narrow git surface live code needs: remote URL lookup for repo identity
 * resolution. A non-zero exit is a legitimate ANSWER (no such remote), so the
 * call branches on `ExecResult.code` rather than throwing.
 */
import type {ExecOptions} from '../shared/index.js'
import {defaultGitRunner, type GitRunner} from './exec-tools.js'

/** Per-call git options: which worktree/repo dir to run in. */
export interface GitOpts {
    /** Working directory (worktree path). Defaults to the process cwd. */
    cwd?: string | undefined
}

/** The typed git surface. */
export interface GitClient {
    /**
     * `git remote get-url <remote>` → the remote URL, or `null` when the remote is
     * absent / the dir is not a git repo (a non-zero exit is a normal NO — used to
     * auto-derive `--repo`, where "no origin" is a legitimate answer, not an error).
     */
    remoteUrl(remote: string, opts?: GitOpts): Promise<string | null>
}

/** Default GitClient over the real (or an injected) git runner. */
export class DefaultGitClient implements GitClient {
    private readonly runner: GitRunner

    constructor(runner: GitRunner = defaultGitRunner) {
        this.runner = runner
    }

    private toExecOpts(opts?: GitOpts): ExecOptions {
        return opts?.cwd != null && opts.cwd.length > 0 ? {cwd: opts.cwd} : {}
    }

    async remoteUrl(remote: string, opts?: GitOpts): Promise<string | null> {
        // A non-zero exit (no such remote / not a git repo) is the ANSWER, not an
        // error — auto-derive treats "no origin" as not-derivable, never a throw.
        const r = await this.runner(['remote', 'get-url', remote], this.toExecOpts(opts))
        if (r.code !== 0) {
            return null
        }
        const url = r.stdout.trim()
        return url.length > 0 ? url : null
    }
}
