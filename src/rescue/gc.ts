/**
 * WS12 — rescue GC (D55): the orphaned staging-branch/protection sweep.
 *
 * Every other rescue helper deliberately excludes terminal runs — which is
 * exactly the population that leaks protected `staging-<run-id>` branches when
 * a teardown path never fired (a failed run banked for rescue, a crash between
 * finalize steps, a suspended run abandoned after its PRD shipped out-of-band).
 * `gcScan` probes GitHub for each terminal/suspended run's pinned
 * `staging_branch` and reports what is still live; `gcApply` tears ONE terminal
 * run's leftovers down (protection FIRST — GitHub blocks deleting a protected
 * ref). Model A: scan proposes with exact hints, apply is the only writer, and
 * consent (incl. the terminal-only refusal) lives in the CLI layer.
 *
 * Suspended runs are NEVER apply targets — deleting their branch destroys
 * resumability — so they only get the `run cancel --cleanup` hint.
 *
 * ponytail: candidates come from run state only. A rule lingering on a branch
 * deleted out-of-band is invisible to the REST branch-protection endpoints
 * (404 on a missing branch) and would need the GraphQL rules API to enumerate.
 */
import {isTerminalRunStatus} from '../core/state/index.js'
import {splitRepoSlug, type GhClient} from '../git/index.js'
import type {RunState, RunStatus} from '../types/index.js'

/** One terminal run with GitHub leftovers — a proposable GC target. */
export interface GcFinding {
    run_id: string
    run_status: RunStatus
    staging_branch: string
    branch_exists: boolean
    protection_live: boolean
    /** A failed run's branch is deliberately kept for rescue — GC only with intent. */
    banked: boolean
    /** The exact apply command. */
    hint: string
}

/** A suspended run with a live branch — cancel it first, never GC it directly. */
export interface GcSuspendedLine {
    run_id: string
    staging_branch: string
    updated_at: string
    hint: string
}

export interface GcReport {
    findings: GcFinding[]
    suspended: GcSuspendedLine[]
}

/** What one run's staging branch still has live on GitHub. */
async function probeLeftovers(run: RunState, gh: GhClient): Promise<{branch: boolean; protection: boolean}> {
    const {owner, repo} = splitRepoSlug(run.spec.repo)
    return {
        branch: await gh.branchExists(owner, repo, run.staging_branch),
        protection: (await gh.repoProtection(owner, repo, run.staging_branch)).enabled,
    }
}

/**
 * Probe every terminal + suspended run for live staging-branch leftovers.
 * Read-only; active (running/paused) runs are never candidates.
 */
export async function gcScan(runs: readonly RunState[], gh: GhClient): Promise<GcReport> {
    const findings: GcFinding[] = []
    const suspended: GcSuspendedLine[] = []
    for (const run of runs) {
        const terminal = isTerminalRunStatus(run.status)
        if (!terminal && run.status !== 'suspended') {
            continue
        }
        const live = await probeLeftovers(run, gh)
        if (!live.branch && !live.protection) {
            continue
        }
        if (terminal) {
            findings.push({
                run_id: run.run_id,
                run_status: run.status,
                staging_branch: run.staging_branch,
                branch_exists: live.branch,
                protection_live: live.protection,
                banked: run.status === 'failed',
                hint: `factory rescue gc --apply --run ${run.run_id}`,
            })
        } else {
            suspended.push({
                run_id: run.run_id,
                staging_branch: run.staging_branch,
                updated_at: run.updated_at,
                hint: `factory run cancel --run ${run.run_id} --cleanup`,
            })
        }
    }
    return {findings, suspended}
}

/** What {@link gcApply} cleaned for one run. */
export interface GcCleaned {
    run_id: string
    staging_branch: string
}

/**
 * Tear down ONE run's staging branch + protection rule. Protection FIRST —
 * GitHub blocks deleting a protected ref. Both deletes are 404-tolerant, so
 * re-running over an already-clean run is an idempotent no-op; a genuine
 * failure (auth/5xx) propagates. The caller enforces the terminal-only gate.
 */
export async function gcApply(run: RunState, gh: GhClient): Promise<GcCleaned> {
    const {owner, repo} = splitRepoSlug(run.spec.repo)
    await gh.deleteProtection(owner, repo, run.staging_branch)
    await gh.deleteRemoteBranch(owner, repo, run.staging_branch)
    return {run_id: run.run_id, staging_branch: run.staging_branch}
}
