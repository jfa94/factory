import {execOrThrow} from '../shared/exec.js'

async function remoteHeads(root: string, remote: string): Promise<Set<string>> {
    const {stdout} = await execOrThrow('git', ['ls-remote', '--heads', remote], {cwd: root})
    const names = stdout.split('\n').map((line) => /\trefs\/heads\/(.+)$/.exec(line.trim())?.[1])
    return new Set(names.filter((name): name is string => name !== undefined))
}

/**
 * Decision 8: an explicit `git.baseBranch` must exist on the remote; unset means `develop`
 * when the remote has it, else the remote's HEAD branch. Never persisted back to config.
 */
export async function resolveBaseBranch(
    root: string,
    configured: string | undefined,
    remote = 'origin'
): Promise<string> {
    const heads = await remoteHeads(root, remote)
    if (configured !== undefined) {
        if (!heads.has(configured)) {
            throw new Error(`git.baseBranch '${configured}' does not exist on ${remote}; fix git.baseBranch or push it`)
        }
        return configured
    }
    if (heads.has('develop')) {
        return 'develop'
    }
    const {stdout} = await execOrThrow('git', ['ls-remote', '--symref', remote, 'HEAD'], {cwd: root})
    const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(stdout)?.[1]
    if (branch === undefined || !heads.has(branch)) {
        throw new Error(`cannot resolve ${remote}'s default branch; set git.baseBranch`)
    }
    return branch
}
