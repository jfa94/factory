import type {FeatureRun, FeatureSpec, Stage, Claim} from './schema.js'

/** Unusable agent output: the engine re-issues `roles` with the reason, at most twice, then parks. */
export class ResultRejected extends Error {
    constructor(
        readonly roles: string[],
        reason: string,
        readonly freshSnapshot = false
    ) {
        super(reason)
    }
}

/** A git/gh/install failure worth retrying after a wait; five in a row park the run. */
export class TransientFailure extends Error {}

/** Why the tests stage counts as RED: a failing assertion, a missing declared module, or tests only CI can run. */
export type RedKind = 'assertion' | 'missing-declared-module' | 'delegated-to-ci'
export interface CheckResult {
    passed: boolean
    observed: number
    details: string[]
    /** Set only at the tests stage, and only when the task's tagged test-only commits demonstrate RED. */
    red?: RedKind
}
export interface DeliveryResult {
    kind: 'merged' | 'review' | 'pending' | 'failed'
    number: number
    url: string
    head: string
    reason?: string
}
export interface QuotaWait {
    reason: string
    seconds: number
}
export interface FeatureRuntime {
    readonly ciWaitMinutes: number
    now(): string
    prepare(root: string, worktree: string, branch: string, base: string): Promise<void>
    head(worktree: string): Promise<string>
    clean(worktree: string): Promise<boolean>
    ancestor(worktree: string, ancestor: string, head: string): Promise<boolean>
    exempt(run: FeatureRun): Promise<boolean>
    checks(run: FeatureRun, stage: Stage): Promise<CheckResult>
    /** Every commit since the task checkpoint is a tagged tests-only commit (none is fine). */
    testsOnly(run: FeatureRun): Promise<boolean>
    snapshot(run: FeatureRun, id: string, head: string): Promise<string>
    /** `git worktree remove --force` from the run root; the engine checks the path first. */
    removeSnapshot(run: FeatureRun, path: string): Promise<void>
    /** The feature range's base: `git merge-base HEAD <remote>/<base_branch>` in the feature worktree. */
    featureBase(run: FeatureRun): Promise<string>
    citation(worktree: string, claim: Claim): Promise<boolean>
    databaseChanged(run: FeatureRun, base: string): Promise<boolean>
    /** A quota breach and the seconds until its next window boundary, clamped to [60, 3600]. */
    quota(run: FeatureRun): Promise<QuotaWait | undefined>
    reconcileBase(run: FeatureRun): Promise<'unchanged' | 'merged' | 'conflict'>
    noChanges(run: FeatureRun): Promise<boolean>
    mergedDelivery(run: FeatureRun): Promise<DeliveryResult | undefined>
    deliver(run: FeatureRun): Promise<DeliveryResult>
    /** Closes the PRD issue; GitHub auto-closes only on default-branch merges. */
    closeIssue(run: FeatureRun, pr: number): Promise<void>
    validateRepair(run: FeatureRun, spec: FeatureSpec): Promise<void>
}
