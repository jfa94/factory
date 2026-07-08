/**
 * CLI-side ADOPTION helper (Decision 60) — the ONE place the five adoption sites
 * (rescue apply/auto, resume, next-task, reconcile) share their outage policy and
 * metric mirroring.
 *
 * {@link adoptForCli} runs {@link adoptRun} (forward-only GitHub repair), mirrors each
 * applied action to `metrics.jsonl` as an `adoption` line, and returns an envelope
 * field. A gh outage is CONTAINED here as `{ok:false, error}` — callers that must
 * REFUSE on a missing-truth outage (rescue auto) inspect the field and page; callers
 * that proceed (apply, resume, reconcile, next-task) attach it verbatim. Adoptions are
 * FREE: no `self_heal` spend, no `human_touches` (that discipline lives in adopt.ts).
 */
import {
    reconcileRun,
    adoptFromReport,
    summarizeAdoption,
    type AdoptionReport,
    type ReconcileReport,
} from '../rescue/index.js'
import {emitMetric} from '../scoring/index.js'
import {createLogger} from '../shared/index.js'
import type {GhClient, GitClient} from '../git/index.js'
import type {StateManager} from '../core/state/index.js'
import type {RunState} from '../types/index.js'

const log = createLogger('adoption')

/** The envelope field every adoption-aware command attaches. */
export type AdoptionField = ({ok: true} & AdoptionReport) | {ok: false; error: string}

/** Everything {@link adoptForCli} needs — the writer, both git seams, the metric sink. */
export interface AdoptCliDeps {
    readonly state: StateManager
    readonly git: GitClient
    readonly gh: GhClient
    readonly dataDir: string
}

/**
 * Adopt forward-only GitHub repairs for `run`, mirror each applied action to
 * `metrics.jsonl`, and return the contained envelope field. Never throws on a gh
 * outage (returns `{ok:false}`); a real state-write failure still propagates.
 */
export async function adoptForCli(deps: AdoptCliDeps, run: RunState, at: string): Promise<AdoptionField> {
    // ONLY the gh probe is contained: an outage means no trustworthy truth, so return
    // {ok:false} and let the caller apply its outage policy. The state write below runs
    // OUTSIDE the catch so a genuine write failure (schema reject, lock timeout, ENOSPC)
    // propagates instead of masquerading as a gh outage — the documented contract.
    let probe: ReconcileReport
    try {
        probe = await reconcileRun(run, deps.gh)
    } catch (err) {
        return {ok: false, error: err instanceof Error ? err.message : String(err)}
    }
    const report = await adoptFromReport({state: deps.state, git: deps.git}, run, probe, {at})
    return mirrorAdoption(deps.dataDir, run.run_id, report)
}

/**
 * Mirror an already-applied report's actions to `metrics.jsonl` + log, and wrap it as
 * the `{ok:true}` envelope field. Split from {@link adoptForCli} so `reconcile --adopt`
 * — which already holds the reconcile report and applies it via `adoptFromReport` (no
 * second gh probe) — shares the SAME metric/log shape.
 */
export async function mirrorAdoption(
    dataDir: string,
    runId: string,
    report: AdoptionReport
): Promise<{ok: true} & AdoptionReport> {
    for (const a of report.actions) {
        await emitMetric(dataDir, runId, 'adoption', {
            class: a.class,
            action: a.action,
            ...(a.task_id !== undefined ? {task_id: a.task_id} : {}),
            ...(a.pr_number !== undefined ? {pr_number: a.pr_number} : {}),
        })
    }
    if (report.changed) {
        log.info(`run '${runId}': adoption — ${summarizeAdoption(report)}`)
    }
    return {ok: true, ...report}
}
