/**
 * Worktree dependency provisioning.
 *
 * `createTaskWorktree` (worktree.ts) only forks the git tree — it installs NO
 * dependencies. The deterministic command-gates (test/type/build) then run
 * `npx vitest` / `npx tsc` / `npm run build` with `cwd=<worktree>` and have no
 * applicability guard, so an empty `node_modules` makes them FAIL CLOSED. (lint /
 * mutation probe for their binary and skip; test/type/build do not — and must not,
 * since silently skipping the test gate would degrade the merge gate.)
 *
 * This module makes the worktree a runnable environment BEFORE the gates run:
 * resolve a setup command (operator-configured `quality.setupCommand`, else the
 * lockfile-detected install), run it once in the worktree, and FAIL LOUD on a
 * non-zero exit so a broken environment halts at preflight rather than surfacing
 * as an opaque downstream gate failure (Iron Law 3: fail loud, never blind-retry).
 */
import path from 'node:path'
import {exec, createLogger, pathExists} from '../shared/index.js'

const log = createLogger('provision')

/**
 * Lockfile → install command, probed in order (most specific first). The
 * `--frozen-lockfile` / `npm ci` forms install EXACTLY the committed lockfile —
 * deterministic, the right shape for a throwaway gate worktree.
 */
const LOCKFILE_INSTALL: readonly (readonly [string, string])[] = [
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn install --frozen-lockfile'],
    ['package-lock.json', 'npm ci'],
    ['npm-shrinkwrap.json', 'npm ci'],
]

/** Outcome a {@link ProvisionWorktreeArgs.run} runner reports back. */
export interface ProvisionRunResult {
    readonly code: number | null
    readonly stderr: string
}

/** Args to {@link provisionWorktree}. */
export interface ProvisionWorktreeArgs {
    /** Absolute worktree path — the cwd the setup command runs in. */
    readonly path: string
    /** `quality.setupCommand`; when set and non-blank it wins over lockfile detection. */
    readonly setupCommand?: string | undefined
    /** Injectable file-exists predicate (default: real `fs.access`). */
    readonly fileExists?: (absPath: string) => Promise<boolean>
    /** Injectable command runner (default: real shell exec). */
    readonly run?: (command: string, cwd: string) => Promise<ProvisionRunResult>
}

/** A {@link provisionWorktree}-shaped function, for injection into the preflight handler. */
export type ProvisionWorktreeFn = (args: ProvisionWorktreeArgs) => Promise<void>

async function defaultRun(command: string, cwd: string): Promise<ProvisionRunResult> {
    // The command is trusted — operator `quality.setupCommand` or a fixed
    // lockfile-install string — so the `shell` escape hatch is acceptable here.
    const r = await exec(command, [], {cwd, shell: true})
    return {code: r.code, stderr: r.stderr}
}

/**
 * Resolve the provisioning command for a worktree: an explicit, non-blank
 * `setupCommand` wins; else the first matching lockfile's install command; else
 * `null` (a no-op — non-JS repos with no lockfile rely on their own runner via
 * the gate contract's per-gate `command`, Decision 46).
 */
export async function resolveSetupCommand(
    worktreePath: string,
    setupCommand: string | undefined,
    fileExists: (absPath: string) => Promise<boolean>
): Promise<string | null> {
    if (setupCommand !== undefined && setupCommand.trim().length > 0) {
        return setupCommand
    }
    for (const [lockfile, command] of LOCKFILE_INSTALL) {
        if (await fileExists(path.join(worktreePath, lockfile))) {
            return command
        }
    }
    return null
}

/**
 * Install dependencies into a freshly-created task worktree so the deterministic
 * command-gates can run. No-op when there is nothing to install; FAILS LOUD on a
 * non-zero exit.
 */
export async function provisionWorktree(args: ProvisionWorktreeArgs): Promise<void> {
    const fileExists = args.fileExists ?? pathExists
    const run = args.run ?? defaultRun

    const command = await resolveSetupCommand(args.path, args.setupCommand, fileExists)
    if (command === null) {
        log.debug(`no setupCommand and no lockfile in ${args.path} — skipping worktree provisioning`)
        return
    }

    log.info(`provisioning worktree: ${command} (cwd=${args.path})`)
    const res = await run(command, args.path)
    if (res.code !== 0) {
        const detail = res.stderr.trim()
        throw new Error(
            `worktree provisioning failed: \`${command}\` exited ${res.code ?? 'null'} in ${args.path}` +
                (detail.length > 0 ? `\n${detail}` : '')
        )
    }
}
