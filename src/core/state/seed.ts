/**
 * Seed-time DAG integrity — the ONE implementation behind both task-seeding
 * call sites: `run create`'s first batch (`seedTasksFromSpec` in
 * `src/cli/subcommands/run.ts`) and `/factory:debug`'s pass-N append
 * (`appendTasksFromSpec` in `src/debug/batch.ts`, which namespaces ids with
 * `p<pass>-` via `idOf` and re-validates the merged union).
 *
 * Lives here because the invariant it pins is a STATE invariant: `depends_on`
 * is a frozen denormalization of the spec DAG (see TaskStateSchema.depends_on)
 * whose integrity — no duplicate, self, dangling, or cyclic edge — is
 * guaranteed at seed time so the hot traversal readers (next.ts, rescue/scan.ts)
 * never re-check it. Takes a structural task shape, not a SpecManifest:
 * `src/spec` imports core/state (paths), so the reverse import would cycle.
 */
import {validateId} from '../../shared/ids.js'
import type {TaskState} from './schema.js'

/** The slice of a spec task the seeder reads — structurally satisfied by SpecTask. */
export interface SeedableTask {
    readonly task_id: string
    readonly depends_on: readonly string[]
}

/** Error-message parameterization: `<context>: … in <specLabel>`. */
export interface SeedContext {
    /** The calling operation, e.g. "run create" or "appendTasksFromSpec". */
    readonly context: string
    /** The spec being seeded, e.g. "spec 42-checkout" or "spec 42-x (pass 2)". */
    readonly specLabel: string
}

/**
 * Map spec tasks to fresh `pending` {@link TaskState} rows. `idOf` maps a bare
 * spec task id into the run's id space (identity for a fresh run; the
 * `p<pass>-` prefix for a debug batch) and is applied to both `task_id` and
 * every `depends_on` entry. LOUD on a duplicate id, an unsafe id charset, a
 * self-dependency, or a dangling dependency — all within the batch's own id
 * set; error messages name the RAW (unmapped) ids the spec author wrote.
 * Acyclicity is NOT checked here — callers run {@link assertAcyclic} on
 * whichever task set is authoritative (the batch itself, or a merged union).
 */
export function seedTaskRows(
    specTasks: readonly SeedableTask[],
    ctx: SeedContext,
    idOf: (taskId: string) => string = (id) => id
): Record<string, TaskState> {
    const ids = new Set(specTasks.map((t) => idOf(t.task_id)))
    const tasks: Record<string, TaskState> = {}

    for (const t of specTasks) {
        const id = idOf(t.task_id)
        validateId(id, 'task-id')
        if (tasks[id] !== undefined) {
            throw new Error(`${ctx.context}: duplicate task id '${t.task_id}' in ${ctx.specLabel}`)
        }
        const dependsOn = t.depends_on.map(idOf)
        for (const [i, dep] of dependsOn.entries()) {
            if (dep === id) {
                throw new Error(`${ctx.context}: task '${t.task_id}' depends on itself in ${ctx.specLabel}`)
            }
            if (!ids.has(dep)) {
                throw new Error(
                    `${ctx.context}: task '${t.task_id}' depends on unknown task '${t.depends_on[i]}' in ${ctx.specLabel}`
                )
            }
        }
        tasks[id] = {
            task_id: id,
            status: 'pending',
            // Frozen denormalization of the spec DAG edges for hot traversal (next.ts,
            // rescue/scan.ts); integrity pinned by the dangling/self/cyclic/duplicate
            // checks in this module. The risk_tier dial is NOT copied — it is read live
            // from the SpecTask via specTaskOf (derive-don't-store, Decision 25).
            depends_on: dependsOn,
            escalation_rung: 0,
            reviewers: [],
            merge_resyncs: 0,
        }
    }

    return tasks
}

/**
 * LOUD-fail on a dependency cycle (DFS with a recursion stack). The orchestrator
 * would otherwise reach a deadlock — no ready, no blocked, no terminal — and
 * throw at drive time; catching it at seed time names the offending trail.
 */
export function assertAcyclic(tasks: Record<string, TaskState>, ctx: SeedContext): void {
    const VISITING = 1
    const DONE = 2
    const state = new Map<string, number>()

    const visit = (id: string, trail: string[]): void => {
        const mark = state.get(id)
        if (mark === DONE) {
            return
        }
        if (mark === VISITING) {
            throw new Error(`${ctx.context}: dependency cycle in ${ctx.specLabel}: ${[...trail, id].join(' → ')}`)
        }
        state.set(id, VISITING)
        for (const dep of tasks[id]?.depends_on ?? []) {
            visit(dep, [...trail, id])
        }
        state.set(id, DONE)
    }

    for (const id of Object.keys(tasks)) {
        visit(id, [])
    }
}
