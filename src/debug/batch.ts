/**
 * `/factory:debug` multi-pass task appending (Decision 39 rebuild, Task 5).
 *
 * Debug runs multiple "passes" on one long-lived run: each pass generates a
 * fresh {@link SpecManifest} from the prior pass's residual review findings
 * (`src/debug/spec-source.ts`) and needs to APPEND that spec's tasks onto the
 * run's existing (already-completed) task set, without ever colliding task
 * ids across passes.
 *
 * `seedTasksFromSpec` (`src/cli/subcommands/run.ts:184-221`) already does the
 * equivalent for a brand-new run's FIRST batch. This module is the pass-N
 * equivalent: {@link appendTasksFromSpec} prefixes every new task id with
 * `p<passNumber>-` (so pass-2's `fix-auth` can never collide with pass-1's
 * `fix-auth`), unions it against the existing task set, and re-validates the
 * WHOLE union for cycles. Pure — no I/O; the caller (`factory debug seed`)
 * owns the `state.update` write.
 */
import { validateId } from "../shared/ids.js";
import type { SpecManifest } from "../spec/index.js";
import type { TaskState } from "../types/index.js";

/** Namespace a bare spec task id with its debug-pass prefix. */
function namespacedId(passNumber: number, taskId: string): string {
  return `p${passNumber}-${taskId}`;
}

/**
 * Map a {@link SpecManifest}'s tasks to a NEW batch of `pending` {@link
 * TaskState} rows, namespaced with `p<passNumber>-` on both `task_id` and
 * every `depends_on` entry (same-batch dependencies only — a freshly
 * generated spec's dependencies always point at sibling tasks in that same
 * spec). LOUD on a duplicate id, unsafe id charset, self-dependency, or
 * dangling dependency WITHIN the new batch — mirrors `seedTasksFromSpec`'s
 * checks, scoped to the new batch's own id set.
 */
function namespaceBatch(request: SpecManifest, passNumber: number): Record<string, TaskState> {
  const ids = new Set(request.tasks.map((t) => namespacedId(passNumber, t.task_id)));
  const tasks: Record<string, TaskState> = {};

  for (const t of request.tasks) {
    const id = namespacedId(passNumber, t.task_id);
    validateId(id, "task-id");
    if (tasks[id] !== undefined) {
      throw new Error(
        `appendTasksFromSpec: duplicate task id '${t.task_id}' in spec ${request.spec_id} (pass ${passNumber})`,
      );
    }
    const dependsOn = t.depends_on.map((dep) => namespacedId(passNumber, dep));
    for (const [i, dep] of dependsOn.entries()) {
      const rawDep = t.depends_on[i];
      if (dep === id) {
        throw new Error(
          `appendTasksFromSpec: task '${t.task_id}' depends on itself in spec ${request.spec_id} (pass ${passNumber})`,
        );
      }
      if (!ids.has(dep)) {
        throw new Error(
          `appendTasksFromSpec: task '${t.task_id}' depends on unknown task '${rawDep}' in spec ${request.spec_id} (pass ${passNumber})`,
        );
      }
    }
    tasks[id] = {
      task_id: id,
      status: "pending",
      depends_on: dependsOn,
      escalation_rung: 0,
      reviewers: [],
      merge_resyncs: 0,
    };
  }

  return tasks;
}

/**
 * LOUD-fail on a dependency cycle across the FULL union of tasks (existing +
 * new batch). Same DFS-with-recursion-stack shape as `run.ts`'s private
 * `assertAcyclic` — reproduced locally rather than exported from `run.ts`
 * (Task 5 brief: avoid widening the exported surface of a large, sensitive
 * file other tasks also touch).
 */
function assertAcyclic(tasks: Record<string, TaskState>, specId: string, passNumber: number): void {
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();

  const visit = (id: string, trail: string[]): void => {
    const mark = state.get(id);
    if (mark === DONE) return;
    if (mark === VISITING) {
      throw new Error(
        `appendTasksFromSpec: dependency cycle in spec ${specId} (pass ${passNumber}): ${[...trail, id].join(" → ")}`,
      );
    }
    state.set(id, VISITING);
    for (const dep of tasks[id]?.depends_on ?? []) {
      visit(dep, [...trail, id]);
    }
    state.set(id, DONE);
  };

  for (const id of Object.keys(tasks)) visit(id, []);
}

/**
 * Append a debug pass's spec tasks onto an existing run's task set.
 *
 * Every new task's `task_id` (and its own `depends_on` entries) is prefixed
 * `p<passNumber>-`, guaranteeing no collision with any prior pass's ids by
 * construction — prefix uniqueness holds as long as passes are monotonically
 * increasing and each pass's own ids are already unique within itself (the
 * duplicate-id check in {@link namespaceBatch}). The new batch is validated in
 * isolation (duplicate/self/dangling), merged with `existingTasks`, then the
 * FULL union is re-validated for cycles — a new task depending (directly or
 * transitively) on nothing existing can't introduce one, but the union check
 * stays authoritative rather than assumed.
 *
 * Pure: no I/O. The caller (`factory debug seed`) performs the actual
 * `state.update(runId, s => ({...s, tasks: appendTasksFromSpec(s.tasks, request, passNumber)}))`.
 */
export function appendTasksFromSpec(
  existingTasks: Record<string, TaskState>,
  request: SpecManifest,
  passNumber: number,
): Record<string, TaskState> {
  const newBatch = namespaceBatch(request, passNumber);
  const merged: Record<string, TaskState> = { ...existingTasks, ...newBatch };
  assertAcyclic(merged, request.spec_id, passNumber);
  return merged;
}
