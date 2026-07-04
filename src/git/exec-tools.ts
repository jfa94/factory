/**
 * WS3 — the ONE injectable exec seam every git/gh module binds to.
 *
 * No module in src/git calls node:child_process directly. They all depend on a
 * {@link GitRunner} / {@link GhRunner} — a thin function binding a command name
 * ("git" | "gh") to the frozen `src/shared/exec`. Production code uses the
 * defaults (which call the real binaries); unit tests pass a fake runner and
 * need NO real git/gh installed (the "wrap every external CLI behind an
 * injectable interface" rule).
 *
 * A runner returns the raw {@link ExecResult} (incl. `truncated`) — it does NOT
 * throw on a non-zero exit. Callers branch on `code` where a non-zero is a
 * legitimate answer (e.g. `git show-ref` miss), and use {@link runOrThrow} where
 * a failure is fatal. `truncated` drives loud-on-clip JSON parsing in gh-client.
 */
import {exec, type ExecOptions, type ExecResult, ExecError} from '../shared/index.js'

/** A function that runs a subcommand of one bound CLI and reports the result. */
export type CommandRunner = (args: readonly string[], opts?: ExecOptions) => Promise<ExecResult>

/** Runs `git ...`. Defaults to the real binary; overridable in tests. */
export type GitRunner = CommandRunner
/** Runs `gh ...`. Defaults to the real binary; overridable in tests. */
export type GhRunner = CommandRunner

/** Bind {@link exec} to a fixed command name, yielding a {@link CommandRunner}. */
export function makeRunner(command: string): CommandRunner {
    return (args, opts) => exec(command, args, opts)
}

/** The default `git` runner (real binary). */
export const defaultGitRunner: GitRunner = makeRunner('git')
/** The default `gh` runner (real binary). */
export const defaultGhRunner: GhRunner = makeRunner('gh')

/**
 * Run a runner and throw an {@link ExecError} unless it exits 0. The mirror of
 * `execOrThrow`, but over an injectable runner (so it works against the fakes).
 * `command` is only for the error message.
 */
export async function runOrThrow(
    command: string,
    runner: CommandRunner,
    args: readonly string[],
    opts?: ExecOptions
): Promise<ExecResult> {
    const result = await runner(args, opts)
    if (result.code !== 0) {
        throw new ExecError(command, args, result)
    }
    return result
}
