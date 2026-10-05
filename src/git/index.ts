/**
 * `src/git` — public seam: git/gh wrappers, repo identity resolution, worktree
 * dependency provisioning, and the branch-protection probe/gate. Test fakes live
 * in `./fakes.js` and are imported directly by tests, never through this barrel.
 */

// exec seam (injectable runners)
export {makeRunner, runOrThrow, defaultGitRunner, defaultGhRunner} from './exec-tools.js'
export type {CommandRunner, GitRunner, GhRunner} from './exec-tools.js'

// git client
export {DefaultGitClient} from './git-client.js'
export type {GitClient, GitOpts} from './git-client.js'

// repo identity resolution (Prompt G / F-repo): auto-derive --repo from origin
export {parseRemoteUrl, validateRepoSlug, isValidRepoSlug, splitRepoSlug, resolveRepo} from './repo.js'
export type {ResolveRepoArgs} from './repo.js'

// gh client
export {DefaultGhClient, parseGhJson} from './gh-client.js'
export type {GhClient, GhOpts, ProtectionApiResult, ProtectionPutBody} from './gh-client.js'

// worktree dependency provisioning (setupCommand / lockfile install before gates)
export {provisionWorktree, resolveSetupCommand} from './provision.js'
export type {ProvisionWorktreeArgs, ProvisionWorktreeFn, ProvisionRunResult} from './provision.js'

// branch-protection probe + gate (#2 / Δ A)
export {
    probeProtection,
    requireProtectionOrRefuse,
    provisionProtection,
    effectiveProfiles,
    ProtectionMissingError,
} from './protection.js'
export type {ProtectionState, ProbeProtectionArgs, ProvisionProtectionArgs, EffectiveProfiles} from './protection.js'
