/**
 * `/factory:debug` multi-pass task appending (Decision 39 rebuild, Task 5).
 *
 * Debug runs multiple "passes" on one long-lived run: each pass generates a
 * fresh {@link SpecManifest} from the prior pass's residual review findings
 * (`src/debug/spec-source.ts`) and needs to APPEND that spec's tasks onto the
 * run's existing (already-completed) task set, without ever colliding task
 * ids across passes.
 *
 * The seeding + DAG-integrity mechanics live in `src/core/state/seed.ts` — the
 * same implementation `run create`'s first-batch `seedTasksFromSpec` uses.
 * This module contributes only the pass-N parameterization:
 * {@link appendTasksFromSpec} prefixes every new task id with `p<passNumber>-`
 * (so pass-2's `fix-auth` can never collide with pass-1's `fix-auth`), unions
 * it against the existing task set, and re-validates the WHOLE union for
 * cycles. Pure — no I/O; the caller (`factory debug seed`) owns the
 * `state.update` write.
 */
import {seedTaskRows, assertAcyclic} from '../core/state/index.js'
import type {SpecManifest} from '../spec/index.js'
import type {TaskState} from '../types/index.js'

/** Namespace a bare spec task id with its debug-pass prefix. */
function namespacedId(passNumber: number, taskId: string): string {
    return `p${passNumber}-${taskId}`
}

/**
 * Append a debug pass's spec tasks onto an existing run's task set.
 *
 * Every new task's `task_id` (and its own `depends_on` entries) is prefixed
 * `p<passNumber>-`, guaranteeing no collision with any prior pass's ids by
 * construction — prefix uniqueness holds as long as passes are monotonically
 * increasing and each pass's own ids are already unique within itself (the
 * duplicate-id check in `seedTaskRows`). The new batch is validated in
 * isolation (duplicate/self/dangling — same-batch dependencies only: a freshly
 * generated spec's dependencies always point at sibling tasks in that same
 * spec), merged with `existingTasks`, then the FULL union is re-validated for
 * cycles — a new task depending (directly or transitively) on nothing existing
 * can't introduce one, but the union check stays authoritative rather than
 * assumed.
 *
 * Pure: no I/O. The caller (`factory debug seed`) performs the actual
 * `state.update(runId, s => ({...s, tasks: appendTasksFromSpec(s.tasks, request, passNumber)}))`.
 */
export function appendTasksFromSpec(
    existingTasks: Record<string, TaskState>,
    request: SpecManifest,
    passNumber: number
): Record<string, TaskState> {
    const ctx = {
        context: 'appendTasksFromSpec',
        specLabel: `spec ${request.spec_id} (pass ${passNumber})`,
    }
    const newBatch = seedTaskRows(request.tasks, ctx, (id) => namespacedId(passNumber, id))
    const merged: Record<string, TaskState> = {...existingTasks, ...newBatch}
    assertAcyclic(merged, ctx)
    return merged
}
