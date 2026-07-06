/**
 * S10 — effectiveAutoResets (Decision 48): the auto-safe filter behind
 * `factory rescue auto`, the ONE bounded self-heal cycle the runner fires
 * after a failed finalize.
 *
 * The auto-safe candidate set is `scan.resettable` (stuck ∪ recoverable) — the
 * same set a default human `rescue apply` resets. Dead-ends, e2e resets, rollup
 * rechecks, and git-drift reconciliation are NEVER auto (each requires a human
 * assertion that the underlying cause is fixed).
 *
 * The filter: a reset counts only if the task is actionable POST-reset.
 * Simulate every candidate → `pending`; a candidate survives iff no task in its
 * transitive `depends_on` closure remains `failed` or missing. A surviving
 * closure then contains only `done` and `pending` rows (every in-flight task is
 * itself stuck ⇒ a candidate ⇒ simulated `pending`), so the re-drive can make
 * real progress. Without the filter, a candidate downstream of a dead-end just
 * re-cascades to `failed` and re-finalizes — a pure quota burn with no outcome
 * change, which is exactly the loop this function exists to kill.
 *
 * Pure over {RunState, RescueScan}; the readiness semantics mirror
 * `depsSatisfied`/`hasUnsatisfiableDep` (scan.ts / orchestrator/next.ts).
 */
import type {RunState} from '../types/index.js'
import type {RescueScan} from './scan.js'
import {nonNull} from '../shared/index.js'

/** The subset of `scan.resettable` worth auto-resetting (in scan order). */
export function effectiveAutoResets(run: RunState, scan: RescueScan): string[] {
    const resets = new Set(scan.resettable)
    // memo: task id → its simulated transitive closure is free of failed/missing rows.
    const clean = new Map<string, boolean>()

    function closureClean(id: string, visiting: Set<string>): boolean {
        const memoized = clean.get(id)
        if (memoized !== undefined) {
            return memoized
        }
        // Cycle guard: the spec gate guarantees an acyclic task graph, so a revisit on
        // the current path contributes no failure evidence — just stop descending.
        if (visiting.has(id)) {
            return true
        }

        const task = run.tasks[id]
        if (task === undefined) {
            return false
        } // missing dep — unsatisfiable forever
        const status = resets.has(id) ? 'pending' : task.status
        if (status === 'failed') {
            clean.set(id, false)
            return false
        }
        if (status === 'done') {
            clean.set(id, true)
            return true
        }

        visiting.add(id)
        const ok = task.depends_on.every((dep) => closureClean(dep, visiting))
        visiting.delete(id)
        clean.set(id, ok)
        return ok
    }

    return scan.resettable.filter((id) =>
        nonNull(run.tasks[id]).depends_on.every((dep) => closureClean(dep, new Set([id])))
    )
}
