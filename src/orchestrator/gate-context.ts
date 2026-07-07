/**
 * The ONE composition site for the deterministic-gate context + holdout gate
 * evidence, shared by the two verify consumers: the verify reporter's
 * merge-resync fast-path (`handlers.ts`) and the sanctioned review record
 * (`record.ts applyRecordReviews`). Structurally identical by contract — a field
 * added to one side but not the other is exactly the drift this module prevents.
 */
import {taskExemptReader} from './exempt.js'
import {taskWorktreePath} from './paths.js'
import {runCoverageDir} from '../core/state/index.js'
import {FsCoverageStore, type GateContext} from '../verifier/deterministic/index.js'
import {deriveHoldoutEvidence, type HoldoutVerdictStore} from '../verifier/holdout/index.js'
import type {HandlerDeps} from './types.js'
import type {GateEvidence} from '../types/index.js'

/** Build the GateContext both verify consumers hand the GateRunner. */
export function buildGateContext(deps: HandlerDeps, runId: string, taskId: string, baseRef: string): GateContext {
    const worktree = taskWorktreePath(deps.dataDir, runId, taskId)
    return {
        runId,
        taskId,
        worktree,
        baseRef,
        config: deps.config,
        tools: deps.tools,
        exemptReader: taskExemptReader(deps, worktree),
        ...(deps.loadContract === undefined ? {} : {loadContract: deps.loadContract}),
        coverageStore: new FsCoverageStore(runCoverageDir(deps.dataDir, runId)),
    }
}

/**
 * Append the holdout gate evidence (derived from the persisted verdicts) to
 * `evidence`, in place. No-op when the task has no withheld answer key.
 */
export async function appendHoldoutEvidence(
    deps: HandlerDeps,
    verdictStore: HoldoutVerdictStore,
    runId: string,
    taskId: string,
    rung: number,
    evidence: GateEvidence[]
): Promise<void> {
    const holdoutGate = await deriveHoldoutEvidence(
        deps.holdout,
        verdictStore,
        runId,
        taskId,
        rung,
        deps.config.quality.holdoutPassRate
    )
    if (holdoutGate !== undefined) {
        evidence.push(holdoutGate)
    }
}
