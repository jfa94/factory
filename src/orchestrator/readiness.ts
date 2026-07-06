/**
 * Task-readiness predicates — the DEFINITIONAL meaning of "ready" / "blocked".
 *
 * A dependency-free leaf (imports state types only) so BOTH the run-level
 * orchestrator (`next.ts`) and rescue's scan (`src/rescue/scan.ts`) share one
 * source of truth without a rescue→next→deps→rescue import cycle.
 */
import type {RunState} from '../core/state/index.js'

/** True iff every listed dependency is `done`. */
export function depsSatisfied(run: RunState, depends: readonly string[]): boolean {
    return depends.every((d) => run.tasks[d]?.status === 'done')
}

/** A dependency is unsatisfiable when it is absent or already failed. */
export function isUnsatisfiableDep(run: RunState, depId: string): boolean {
    const dep = run.tasks[depId]
    return dep === undefined || dep.status === 'failed'
}
