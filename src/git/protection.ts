/**
 * WS3 — branch-protection STATE PROBE + refuse-to-run gate (#2 / Δ A).
 *
 * The PROBE lives HERE in src/git per the ownership note (the PreToolUse hook
 * BODY belongs to WS9/src/hooks). By default the run VERIFIES protection and
 * REFUSES to start when it is missing — the structural guarantee that a task PR
 * can only ever land on a protected, strict-up-to-date staging branch (so the
 * serial writer's up-to-date enforcement is backed by GitHub, not just app-level
 * hope). Provisioning is OPT-IN (--provision); default OFF.
 */
import {createLogger} from '../shared/index.js'
import {GitSchema} from '../config/schema.js'
import type {GhClient} from './gh-client.js'
import type {ProtectionApiResult} from './gh-client.js'

const log = createLogger('git')

const GIT_DEFAULTS = GitSchema.parse({})

/** Typed protection state the gate reasons over. */
export interface ProtectionState {
    enabled: boolean
    requiredStatusChecks: string[]
    strictUpToDate: boolean
    hasMergeQueue: boolean
}

/** Thrown when protection / required checks / strict-up-to-date are absent. */
export class ProtectionMissingError extends Error {
    readonly branch: string
    readonly reasons: string[]
    constructor(branch: string, reasons: string[]) {
        super(
            `branch protection on '${branch}' is insufficient — run refuses to start:\n  - ${reasons.join(
                '\n  - '
            )}\nRe-run with --provision to provision protection, or configure it manually.`
        )
        this.name = 'ProtectionMissingError'
        this.branch = branch
        this.reasons = reasons
    }
}

/** Args to {@link probeProtection}. */
export interface ProbeProtectionArgs {
    ghClient: GhClient
    owner: string
    repo: string
    /** Branch to probe. Defaults to the configured staging branch. */
    branch?: string
}

/** Probe live branch-protection state (read-only). */
export async function probeProtection(args: ProbeProtectionArgs): Promise<ProtectionState> {
    const branch = args.branch ?? GIT_DEFAULTS.stagingBranch
    const result: ProtectionApiResult = await args.ghClient.repoProtection(args.owner, args.repo, branch)
    return {
        enabled: result.enabled,
        requiredStatusChecks: result.requiredStatusChecks,
        strictUpToDate: result.strictUpToDate,
        hasMergeQueue: result.hasMergeQueue,
    }
}

/**
 * Verify-and-REFUSE gate. Throws {@link ProtectionMissingError} when protection
 * is missing, strict-up-to-date is off (the serial-writer's backbone — Δ L), or
 * any `requiredChecks` context is not enforced. Returns the state on success.
 */
export function requireProtectionOrRefuse(
    state: ProtectionState,
    requiredChecks: readonly string[],
    branch: string = GIT_DEFAULTS.stagingBranch
): ProtectionState {
    const reasons: string[] = []
    if (!state.enabled) {
        reasons.push('no branch protection is configured')
    }
    // strict-up-to-date is the GitHub-backed half of required-branches-up-to-date
    // (Δ L). Without it the serial writer cannot trust that a "merge now" lands on
    // top of the latest staging.
    if (!state.strictUpToDate) {
        reasons.push('required_status_checks.strict (branches up-to-date) is OFF')
    }
    for (const check of requiredChecks) {
        if (!state.requiredStatusChecks.includes(check)) {
            reasons.push(`required status check '${check}' is not enforced`)
        }
    }
    if (reasons.length > 0) {
        throw new ProtectionMissingError(branch, reasons)
    }
    return state
}

/** Args to {@link provisionProtection}. */
export interface ProvisionProtectionArgs {
    ghClient: GhClient
    owner: string
    repo: string
    branch?: string
    requiredChecks: readonly string[]
    /** Must be true (--provision). A false value REFUSES rather than provisions. */
    provision: boolean
}

/**
 * Provision protection via the gh-client PUT — invoked ONLY when --provision is
 * opted in. With `provision:false` this throws (it must never silently mutate a
 * repo's protection without explicit opt-in).
 */
export async function provisionProtection(args: ProvisionProtectionArgs): Promise<ProtectionState> {
    const branch = args.branch ?? GIT_DEFAULTS.stagingBranch
    if (!args.provision) {
        throw new Error('provisionProtection called without --provision opt-in — refusing to mutate branch protection')
    }
    log.info(`--provision: writing branch protection for ${args.owner}/${args.repo}@${branch}`)
    await args.ghClient.putProtection(args.owner, args.repo, branch, {
        requiredStatusChecks: [...args.requiredChecks],
        strict: true,
    })
    // Re-probe so the caller sees the post-PUT state (and can re-assert the gate).
    return probeProtection({
        ghClient: args.ghClient,
        owner: args.owner,
        repo: args.repo,
        branch,
    })
}
