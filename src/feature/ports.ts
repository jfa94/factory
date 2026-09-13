import type {FeatureRun, FeatureSpec, Stage, Claim} from './schema.js'

export interface CheckResult {
    passed: boolean
    observed: number
    details: string[]
    assertionFailure: boolean
}
export interface DeliveryResult {
    kind: 'merged' | 'review' | 'pending' | 'failed'
    number: number
    url: string
    head: string
    reason?: string
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
    snapshot(run: FeatureRun, id: string, head: string): Promise<string>
    citation(worktree: string, claim: Claim): Promise<boolean>
    databaseChanged(run: FeatureRun, base: string): Promise<boolean>
    quota(run: FeatureRun): Promise<string | undefined>
    reconcileBase(run: FeatureRun): Promise<'unchanged' | 'merged' | 'conflict'>
    noChanges(run: FeatureRun): Promise<boolean>
    mergedDelivery(run: FeatureRun): Promise<DeliveryResult | undefined>
    deliver(run: FeatureRun): Promise<DeliveryResult>
    validateRepair(run: FeatureRun, spec: FeatureSpec): Promise<void>
}
