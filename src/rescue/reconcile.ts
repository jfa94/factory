/**
 * P1 — GitHub RECONCILE (read-only facts + drift classification).
 *
 * `scanRun` is pure over {@link RunState}, so state↔GitHub drift — a PR merged
 * but never recorded `done`, a closed-unmerged PR, a landed "auto-armed" rollup,
 * a deleted staging branch — was invisible to the engine (the old scan header's
 * self-documented blind spot). This module closes it, read-only: `gatherRunFacts`
 * probes GitHub through the single {@link GhClient} seam, `classifyDrift` (pure)
 * names the drift, and both `rescue scan` (contained: gh outage → `{ok:false}`)
 * and `factory reconcile` (loud: gh facts ARE the job) report the result.
 * Nothing here mutates state or GitHub — forward-only WRITES over this same
 * report live in the sibling adopt module (`src/rescue/adopt.ts`, Decision 60).
 *
 * What is deliberately NOT probed:
 *   - Per-task remote branches in general: task branches are LOCAL until ship
 *     pushes them, and the serial writer deletes the remote head right after
 *     every merge — so remote absence is the NORMAL state both pre-ship and
 *     post-merge. The head is probed ONLY when its recorded PR is OPEN (the one
 *     shape where a missing branch is real drift: resume needs a re-push).
 *     Local branch existence stays `assessWork`'s job.
 *   - Unrecorded MERGED PRs on a task head: an e2e reopen reuses the same
 *     deterministic branch after `clearShippedPr` wiped `pr_number`, so a
 *     MERGED PR with no recorded number is a NORMAL shape, not drift (the same
 *     `knownPrNumber` gate `bindTaskPr` applies).
 *
 * Failure semantics: all-or-nothing. Any gh failure propagates (the seam's
 * 404-is-an-answer / other-errors-throw discipline) — no partial facts.
 */
import {isTerminalRunStatus} from '../types/index.js'
import {splitRepoSlug, type GhClient, type PullRequest} from '../git/index.js'
import type {RunState, TaskState, TaskStatus} from '../types/index.js'

/** One PR as the facts carry it (narrowed from {@link PullRequest}). */
export interface PrFact {
    number: number
    state: 'OPEN' | 'CLOSED' | 'MERGED'
    baseRefName: string
    /** The squash-merge commit oid, when MERGED — the merged-SHA fact. */
    merge_sha?: string
    url?: string
}

/** GitHub facts for one task that recorded a branch (i.e. reached ship). */
export interface TaskFacts {
    task_id: string
    branch: string
    recorded_status: TaskStatus
    recorded_pr_number?: number
    /** Every PR ever opened from this head (`prList {state:'all'}`). */
    prs: PrFact[]
    /**
     * Remote head tip — probed ONLY when the recorded PR is found OPEN (see
     * module header). `null` = probed and gone; absent = not probed.
     */
    branch_tip?: string | null
}

/** The GitHub truth `reconcileRun` gathered for one run. */
export interface RunFacts {
    /** `run.spec.repo` ("owner/name") — every probe is repo-explicit. */
    repo: string
    staging: {branch: string; tip: string | null}
    /** Only tasks with a recorded branch; branchless tasks have nothing to probe. */
    tasks: TaskFacts[]
    /** Present iff `run.rollup?.merged === false` — the only shape with anything to check. */
    rollup?: {recorded_number?: number; prs: PrFact[]}
}

/** The named state↔GitHub drift classes (read-only; remedies are manual for now). */
export type DriftClass =
    /** Recorded PR is MERGED on GitHub but the task is not `done` (I-03). */
    | 'merged-unrecorded'
    /** Recorded PR was CLOSED without merging while the task still counts on it (I-08). */
    | 'closed-unmerged'
    /** Recorded `pr_number` matches no PR ever opened from the task's head branch. */
    | 'stale-pr-number'
    /** An OPEN PR exists on the head but state records no `pr_number` (I-04). */
    | 'pr-unrecorded'
    /** Recorded-OPEN PR's head branch is gone on GitHub — resume needs a re-push (I-02). */
    | 'branch-missing'
    /** Non-terminal run whose staging branch is gone — every re-drive fails. */
    | 'staging-missing'
    /** Rollup marker says `merged:false` but the rollup PR IS merged (landed auto-arm). */
    | 'rollup-landed'

/** One classified drift line. */
export interface Drift {
    class: DriftClass
    /** Absent on the run-level classes (staging-missing, rollup-landed). */
    task_id?: string
    branch?: string
    recorded_pr_number?: number
    /** The GitHub-side PR the classification keyed on. */
    pr_number?: number
    pr_state?: PrFact['state']
    merge_sha?: string
    url?: string
    /** One human line including the manual remedy. */
    detail: string
}

/** `gatherRunFacts` + `classifyDrift`, packaged for the two reporters. */
export interface ReconcileReport {
    facts: RunFacts
    drifts: Drift[]
    /** Fold consumers read without scanning drifts. */
    rollup_landed: boolean
}

function toPrFact(pr: PullRequest): PrFact {
    const oid = pr.mergeCommit?.oid
    return {
        number: pr.number,
        state: pr.state,
        baseRefName: pr.baseRefName,
        ...(oid !== undefined ? {merge_sha: oid} : {}),
        ...(pr.url !== undefined ? {url: pr.url} : {}),
    }
}

/**
 * Probe GitHub for the run's truth. Sequential (matches the gc loop); N+1 or
 * N+2 `gh` calls for an N-branched-task run, +1 per recorded-OPEN PR head.
 * Any gh failure propagates — no partial facts.
 */
export async function gatherRunFacts(run: RunState, gh: GhClient): Promise<RunFacts> {
    const slug = run.spec.repo
    const {owner, repo} = splitRepoSlug(slug)

    const stagingTip = await gh.branchTip(owner, repo, run.staging_branch)

    const tasks: TaskFacts[] = []
    for (const t of Object.values(run.tasks)) {
        if (t.branch === undefined) {
            continue
        }
        const prs = (await gh.prList({head: t.branch, state: 'all', repo: slug})).map(toPrFact)
        const hit = t.pr_number !== undefined ? prs.find((p) => p.number === t.pr_number) : undefined
        // The ONE shape where the remote head matters: an OPEN recorded PR whose
        // branch vanished can never update or merge — probe it (see module header).
        const branchTip = hit?.state === 'OPEN' ? await gh.branchTip(owner, repo, t.branch) : undefined
        tasks.push({
            task_id: t.task_id,
            branch: t.branch,
            recorded_status: t.status,
            ...(t.pr_number !== undefined ? {recorded_pr_number: t.pr_number} : {}),
            prs,
            ...(branchTip !== undefined ? {branch_tip: branchTip} : {}),
        })
    }

    const rollup =
        run.rollup?.merged === false
            ? {
                  ...(run.rollup.number !== undefined ? {recorded_number: run.rollup.number} : {}),
                  prs: (await gh.prList({head: run.staging_branch, state: 'all', repo: slug})).map(toPrFact),
              }
            : undefined

    return {
        repo: slug,
        staging: {branch: run.staging_branch, tip: stagingTip},
        tasks,
        ...(rollup !== undefined ? {rollup} : {}),
    }
}

/** Statuses for which a CLOSED-unmerged recorded PR is drift (`failed` is consistent). */
const CLOSED_DRIFT_STATUSES: readonly TaskStatus[] = ['pending', 'executing', 'reviewing', 'shipping']

function classifyTask(t: TaskState, f: TaskFacts): Drift[] {
    // `done` is never classified: its PR is expectedly MERGED (or expectedly OPEN
    // under --no-ship), and nothing about a shipped task is actionable here.
    if (t.status === 'done') {
        return []
    }
    const base = {task_id: f.task_id, branch: f.branch}
    const drifts: Drift[] = []

    if (f.recorded_pr_number !== undefined) {
        const hit = f.prs.find((p) => p.number === f.recorded_pr_number)
        if (hit === undefined) {
            drifts.push({
                class: 'stale-pr-number',
                ...base,
                recorded_pr_number: f.recorded_pr_number,
                detail:
                    `recorded pr_number #${f.recorded_pr_number} matches no PR on head '${f.branch}' ` +
                    `(head has: ${f.prs.length > 0 ? f.prs.map((p) => `#${p.number} ${p.state}`).join(', ') : 'none'}); ` +
                    `the next ship's idempotent create will rebind — or clear the pointer manually`,
            })
        } else if (hit.state === 'MERGED') {
            drifts.push({
                class: 'merged-unrecorded',
                ...base,
                recorded_pr_number: f.recorded_pr_number,
                pr_number: hit.number,
                pr_state: hit.state,
                ...(hit.merge_sha !== undefined ? {merge_sha: hit.merge_sha} : {}),
                ...(hit.url !== undefined ? {url: hit.url} : {}),
                detail:
                    `PR #${hit.number} is MERGED on GitHub but the task is '${t.status}' — ` +
                    `state lost the ship; verify the merge commit is on staging, then record it manually`,
            })
        } else if (hit.state === 'CLOSED' && CLOSED_DRIFT_STATUSES.includes(t.status)) {
            drifts.push({
                class: 'closed-unmerged',
                ...base,
                recorded_pr_number: f.recorded_pr_number,
                pr_number: hit.number,
                pr_state: hit.state,
                ...(hit.url !== undefined ? {url: hit.url} : {}),
                detail:
                    `PR #${hit.number} was CLOSED without merging while the task is '${t.status}' — ` +
                    `reopen the PR or let the next ship open a fresh one`,
            })
        } else if (hit.state === 'OPEN' && f.branch_tip === null) {
            drifts.push({
                class: 'branch-missing',
                ...base,
                recorded_pr_number: f.recorded_pr_number,
                pr_number: hit.number,
                pr_state: hit.state,
                ...(hit.url !== undefined ? {url: hit.url} : {}),
                detail:
                    `PR #${hit.number} is OPEN but its head branch '${f.branch}' is gone on GitHub — ` +
                    `re-push the local branch before resuming`,
            })
        }
    } else {
        const open = f.prs.find((p) => p.state === 'OPEN')
        // An unrecorded MERGED PR is NOT drift — the e2e-reopen shape (module header).
        if (open !== undefined) {
            drifts.push({
                class: 'pr-unrecorded',
                ...base,
                pr_number: open.number,
                pr_state: open.state,
                ...(open.url !== undefined ? {url: open.url} : {}),
                detail:
                    `OPEN PR #${open.number} exists on head '${f.branch}' but state records no pr_number — ` +
                    `informational: the next ship's idempotent create rediscovers it`,
            })
        }
    }
    return drifts
}

/** Pure classification of {@link RunFacts} into named drift lines. */
export function classifyDrift(run: RunState, facts: RunFacts): Drift[] {
    const drifts: Drift[] = []

    for (const f of facts.tasks) {
        const t = run.tasks[f.task_id]
        if (t !== undefined) {
            drifts.push(...classifyTask(t, f))
        }
    }

    // Terminal runs delete their staging branch by design (finalize GC / rescue gc);
    // for a resumable run a missing staging base wedges every re-drive.
    if (!isTerminalRunStatus(run.status) && facts.staging.tip === null) {
        drifts.push({
            class: 'staging-missing',
            branch: facts.staging.branch,
            detail:
                `staging branch '${facts.staging.branch}' is gone on GitHub while the run is '${run.status}' — ` +
                `re-push it from a local clone (or cancel the run) before resuming`,
        })
    }

    if (facts.rollup !== undefined) {
        const landed =
            facts.rollup.recorded_number !== undefined
                ? facts.rollup.prs.find((p) => p.number === facts.rollup?.recorded_number && p.state === 'MERGED')
                : facts.rollup.prs.find((p) => p.state === 'MERGED')
        if (landed !== undefined) {
            drifts.push({
                class: 'rollup-landed',
                pr_number: landed.number,
                pr_state: landed.state,
                ...(landed.merge_sha !== undefined ? {merge_sha: landed.merge_sha} : {}),
                ...(landed.url !== undefined ? {url: landed.url} : {}),
                detail:
                    `rollup PR #${landed.number} IS merged on GitHub but the run's marker says merged:false ` +
                    `(a landed auto-arm) — \`factory rescue apply --run ${run.run_id} --recheck-rollup\``,
            })
        }
    }

    return drifts
}

/** Gather + classify. All-or-nothing: any gh failure propagates (no partial facts). */
export async function reconcileRun(run: RunState, gh: GhClient): Promise<ReconcileReport> {
    const facts = await gatherRunFacts(run, gh)
    const drifts = classifyDrift(run, facts)
    return {facts, drifts, rollup_landed: drifts.some((d) => d.class === 'rollup-landed')}
}
