/**
 * The RUN-LEVEL PUMP — the engine half of the `factory next` seam.
 *
 * One invocation = one run-loop iteration: terminal check → quota gate (persisting
 * pause/suspend) → checkpoint clear on recovery → cascade-drop (transitive,
 * blocked-environmental) → the READY set. Ready = every NON-TERMINAL task whose
 * deps are all `done` — in-flight tasks come first so a crashed driver finishes
 * what it started before opening new work. Deadlock (non-terminal tasks, none
 * ready, none droppable) throws LOUD.
 *
 * Ordering invariant: terminal-run check BEFORE the quota gate — a terminal probe
 * must not write a pause checkpoint (same discipline as pumpTask in pump.ts).
 *
 * Clearing a stale paused/suspended checkpoint on recovery is THIS CALLER's job
 * (the quota gate doc is explicit: "on proceed the gate never writes state;
 * clearing a stale checkpoint on recovery is the CALLER's job").
 *
 * Single-writer assumption: lock-free snapshot reads are sound because v1 has
 * exactly one driver process writing state; subagents never write run state.
 *
 * `cascade_dropped` on the `all-terminal` variant is THIS-INVOCATION-ONLY — it
 * lists tasks dropped by the cascade loop in this call. Authoritative drop
 * visibility lives in run state (task.status === "dropped") and the finalize
 * rollup.
 */
import {
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  clearCheckpoint,
  type RunState,
  type TaskState,
} from "./deps.js";
import { dropTask } from "./transitions.js";
import { applyQuotaGate, type QuotaStop } from "./quota-gate.js";
import type { PumpDeps } from "./pump.js";

export type NextEnvelope =
  | {
      readonly kind: "tasks-ready";
      readonly run_id: string;
      readonly ready: readonly string[];
      readonly cascade_dropped: readonly string[];
    }
  | {
      readonly kind: "all-terminal";
      readonly run_id: string;
      /** Tasks dropped by the cascade loop in THIS invocation (not cumulative). */
      readonly cascade_dropped: readonly string[];
    }
  | {
      readonly kind: "run-terminal";
      readonly run_id: string;
      readonly run_status: (typeof TERMINAL_RUN_STATUSES)[number];
    }
  | {
      readonly kind: "quota-blocked";
      readonly run_id: string;
      readonly scope: QuotaStop["scope"];
      readonly reason: string;
      readonly resets_at_epoch?: number;
    };

/** True iff every dependency of `task` is `done`. */
function depsSatisfied(run: RunState, task: TaskState): boolean {
  return task.depends_on.every((d) => run.tasks[d]?.status === "done");
}

/** A dependency is unsatisfiable when it is absent or already dropped. */
function isUnsatisfiableDep(run: RunState, depId: string): boolean {
  const dep = run.tasks[depId];
  return dep === undefined || dep.status === "dropped";
}

export async function pumpRun(deps: PumpDeps, runId: string): Promise<NextEnvelope> {
  let run = await deps.state.read(runId);

  // 1. Terminal run check BEFORE the quota gate — a finished run must never
  //    write a pause checkpoint (mirrors pumpTask in pump.ts).
  if (isTerminalRunStatus(run.status)) {
    return { kind: "run-terminal", run_id: runId, run_status: run.status };
  }

  // 2. All-tasks-terminal check BEFORE the quota gate — if every task is
  //    already done/dropped there is nothing left to schedule and we must not
  //    write a pause checkpoint on a run that is effectively finished. An empty
  //    run (tasks: {}) is vacuously all-terminal — same semantics as the
  //    post-cascade check in step 6. (Mirrors pumpTask's terminal-before-gate
  //    ordering; see the analogous task-level guard in pump.ts.)
  if (Object.values(run.tasks).every((t) => isTerminalTaskStatus(t.status))) {
    return { kind: "all-terminal", run_id: runId, cascade_dropped: [] };
  }

  // 3. Quota gate — a breach persists the checkpoint and stops cleanly.
  const stop = await applyQuotaGate(deps, runId);
  if (stop !== null) {
    return {
      kind: "quota-blocked",
      run_id: runId,
      scope: stop.scope,
      reason: stop.reason,
      ...(stop.resets_at_epoch !== undefined ? { resets_at_epoch: stop.resets_at_epoch } : {}),
    };
  }

  // 4. Clear stale checkpoint on recovery (paused/suspended → running). The gate
  //    returns null (proceed) for a paused run whose window has expired, but the
  //    run.status is still "paused" — we must reset it and drop the quota field.
  if (run.status === "paused" || run.status === "suspended") {
    const patch = clearCheckpoint();
    run = await deps.state.update(runId, (s) => ({
      ...s,
      status: patch.status,
      quota: patch.quota,
    }));
  }

  // 5. Cascade-drop until stable. Pending tasks with an unsatisfiable dep are
  //    dropped as blocked-environmental; a drop can expose further blocked tasks.
  const cascadeDropped: string[] = [];
  for (;;) {
    run = await deps.state.read(runId);
    const blocked = Object.values(run.tasks).filter(
      (t) => t.status === "pending" && t.depends_on.some((d) => isUnsatisfiableDep(run, d)),
    );
    if (blocked.length === 0) break;
    for (const t of blocked) {
      const unsatisfied = t.depends_on.find((d) => isUnsatisfiableDep(run, d));
      if (unsatisfied === undefined) {
        throw new Error(
          `next: task '${t.task_id}' classified blocked but no unsatisfiable dep found — unreachable`,
        );
      }
      await dropTask(
        deps,
        runId,
        t.task_id,
        "blocked-environmental",
        `dependency '${unsatisfied}' did not complete (dropped or missing)`,
      );
      cascadeDropped.push(t.task_id);
    }
  }
  // `run` is fresh from the loop's last read (no writes since the loop exited).

  // 6. All-tasks-terminal after cascade — the cascade may have resolved the run.
  const tasks = Object.values(run.tasks);

  if (tasks.every((t) => isTerminalTaskStatus(t.status))) {
    return { kind: "all-terminal", run_id: runId, cascade_dropped: cascadeDropped };
  }

  // 7. Build the ready set: non-terminal tasks whose deps are all done.
  //    In-flight tasks (status !== "pending") come first — crash-resume finishes
  //    what was started before opening new work.
  const ready = tasks.filter((t) => !isTerminalTaskStatus(t.status) && depsSatisfied(run, t));
  const inFlight = ready.filter((t) => t.status !== "pending").map((t) => t.task_id);
  const pending = ready.filter((t) => t.status === "pending").map((t) => t.task_id);
  const ordered = [...inFlight, ...pending];

  if (ordered.length === 0) {
    const remaining = tasks
      .filter((t) => !isTerminalTaskStatus(t.status))
      .map((t) => `${t.task_id}=${t.status}`);
    throw new Error(
      `next: no ready tasks but ${remaining.length} remain [${remaining.join(", ")}] — ` +
        `dependency cycle or deadlock`,
    );
  }

  return { kind: "tasks-ready", run_id: runId, ready: ordered, cascade_dropped: cascadeDropped };
}
