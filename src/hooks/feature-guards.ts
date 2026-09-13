import {relative, resolve, sep} from 'node:path'
import {FeatureStore} from '../feature/store.js'
import {terminal, type FeatureRun} from '../feature/schema.js'
import {resolveDataDir} from '../config/load.js'
import {isTestPath} from '../verifier/deterministic/scope.js'
import {isNestedShellOrHookBypass} from './shell-bypass.js'
import {bashWriteTargets} from './write-protection.js'
import {canonicalizePath, isTcbProtected} from './tcb.js'
import {
    allow,
    deny,
    commandOf,
    filePathsOf,
    readHookInput,
    sessionIdOf,
    emitPermissionDecision,
    decisionToExitCode,
    type HookInput,
    type HookDecision,
} from './hook-io.js'
import {EXIT, type ExitCode} from '../shared/exit-codes.js'

function inside(root: string, path: string): boolean {
    const rel = relative(canonicalizePath(root), canonicalizePath(path))
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))
}

/** V2 ownership is anchored to the feature/snapshot path or exact session ID. */
export function decideFeatureGuard(
    input: HookInput | null,
    runs: readonly FeatureRun[],
    dataDir?: string
): HookDecision {
    if (input === null) {
        return allow()
    }
    const cwd = input.cwd ?? process.cwd()
    const paths = filePathsOf(input).map((path) => resolve(cwd, path))
    const session = sessionIdOf(input)
    for (const run of runs) {
        if (terminal(run)) {
            continue
        }
        const attempt = run.in_flight
        const roots = [run.worktree, ...(attempt ? [attempt.worktree] : [])]
        const ownsPath = roots.some((root) => inside(root, cwd) || paths.some((path) => inside(root, path)))
        if (!ownsPath && !(session !== undefined && session === run.owner_session)) {
            continue
        }
        const command = commandOf(input)
        const targets = [...paths, ...bashWriteTargets(command)]
        for (const target of targets) {
            const match = isTcbProtected(target, {repoRoot: run.root, dataDir}, cwd)
            if (match?.rule.category.startsWith('data-') === true) {
                return deny('Factory: engine state, results, locks and durable specs are read-only to agents')
            }
        }
        if (isNestedShellOrHookBypass(command)) {
            return deny('Factory: nested shell or hook bypass is forbidden')
        }
        if (/(^|[\s&;|(])gh\s+pr\s+(create|merge|close)\b/.test(command) || /(^|[\s&;|(])git\s+push\b/.test(command)) {
            return deny('Factory: only the delivery engine may publish the feature')
        }
        if (attempt) {
            const producer = ['tests', 'implement', 'docs', 'e2e-author', 'spec-repair'].includes(attempt.stage)
            for (const path of paths) {
                if (!roots.some((root) => inside(root, path))) {
                    continue
                }
                if (!producer) {
                    return deny('Factory: independent review snapshots are read-only')
                }
                if (attempt.stage === 'tests' && !isTestPath(relative(run.worktree, path))) {
                    return deny('Factory: test-writer may edit only test paths')
                }
            }
        }
    }
    return allow()
}

export async function runFeatureGuard(_argv: string[] = []): Promise<ExitCode> {
    let decision: HookDecision
    try {
        const input = await readHookInput()
        const dataDir = resolveDataDir()
        decision = decideFeatureGuard(input, await new FeatureStore(dataDir).list(), dataDir)
    } catch (error) {
        decision = deny(
            `Factory feature state cannot be checked: ${error instanceof Error ? error.message : String(error)}`
        )
    }
    emitPermissionDecision(decision)
    return decisionToExitCode(decision)
}

/** Stop is observational. Never clear a park, complete delivery, or launch work. */
export async function runFeatureStop(_argv: string[] = []): Promise<ExitCode> {
    try {
        const input = await readHookInput()
        const session = sessionIdOf(input)
        if (session === undefined) {
            return EXIT.OK
        }
        const runs = await new FeatureStore(resolveDataDir()).list()
        for (const run of runs) {
            if (!terminal(run) && run.owner_session === session) {
                process.stderr.write(
                    `Factory ${run.run_id}: ${run.status}; inspect factory state --run ${run.run_id} --ledger before resuming.\n`
                )
            }
        }
        return EXIT.OK
    } catch (error) {
        process.stderr.write(`Factory stop state error: ${error instanceof Error ? error.message : String(error)}\n`)
        return EXIT.ERROR
    }
}
