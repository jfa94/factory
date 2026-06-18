/**
 * The RUN-LEVEL COROUTINE — the engine half of the `factory next` seam.
 *
 * One invocation = one run-loop iteration: terminal check → quota gate (persisting
 * pause/suspend) → checkpoint clear on recovery → cascade-drop (transitive,
 * blocked-environmental) → the READY set. Ready = every NON-TERMINAL task whose
 * deps are all `done` — in-flight tasks come first so a crashed driver finishes
 * what it started before opening new work.
 *
 * Circuit breaker (Decision 34): when no task is actionable yet non-terminal work
 * remains (dependency cycle / mutually-stuck graph), each wedged task is dropped as
 * `spec-defect` and the envelope `all-terminal` is returned. The driver routes this
 * to finalize → `failed`, leaving `develop` clean. Every drop is LOUD (dropTask
 * warns) with the full wedged set in the reason.
 *
 * Ordering invariant: terminal-run check BEFORE the quota gate — a terminal probe
 * must not write a pause checkpoint (same discipline as stepTask in coroutine.ts).
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
import type { CoroutineDeps } from "./coroutine.js";

/**
 * Every variant carries the run's self-resolved context — `run_id`, the canonical
 * `data_dir` (from {@link resolveDataDir}), and the persisted `ship_mode`. The
 * workflow driver adopts these from the FIRST envelope instead of having
 * them marshaled through Workflow `args` (a real object passed as `args` arrives
 * JSON-string-encoded, so a load-bearing arg silently becomes `undefined`).
 */
type NextContext = {
  readonly run_id: string;
  readonly data_dir: string;
  readonly ship_mode: RunState["ship_mode"];
};

export type NextEnvelope =
  | (NextContext & {
      readonly kind: "tasks-ready";
      readonly ready: readonly string[];
      readonly cascade_dropped: readonly string[];
    })
  | (NextContext & {
      readonly kind: "all-terminal";
      /** Tasks dropped by the cascade loop in THIS invocation (not cumulative). */
      readonly cascade_dropped: readonly string[];
    })
  | (NextContext & {
      readonly kind: "run-terminal";
      readonly run_status: (typeof TERMINAL_RUN_STATUSES)[number];
    })
  | (NextContext & {
      readonly kind: "quota-blocked";
      readonly scope: QuotaStop["scope"];
      readonly reason: string;
      readonly resets_at_epoch?: number;
    });

/** True iff every dependency of `task` is `done`. */
function depsSatisfied(run: RunState, task: TaskState): boolean {
  return task.depends_on.every((d) => run.tasks[d]?.status === "done");
}

/** A dependency is unsatisfiable when it is absent or already dropped. */
function isUnsatisfiableDep(run: RunState, depId: string): boolean {
  const dep = run.tasks[depId];
  return dep === undefined || dep.status === "dropped";
}

export async function stepRun(deps: CoroutineDeps, runId: string): Promise<NextEnvelope> {
  let run = await deps.state.read(runId);

  // Self-resolved run context stamped onto EVERY envelope variant (so the workflow
  // driver adopts run_id/data_dir/ship_mode from the first `next`, never from args).
  // `data_dir`/`ship_mode` are immutable for the run; reading the current `run`
  // snapshot at call time is always correct even after the cascade re-reads `run`.
  const ctx = () => ({ run_id: runId, data_dir: deps.dataDir, ship_mode: run.ship_mode });

  // 1. Terminal run check BEFORE the quota gate — a finished run must never
  //    write a pause checkpoint (mirrors stepTask in coroutine.ts).
  if (isTerminalRunStatus(run.status)) {
    return { ...ctx(), kind: "run-terminal", run_status: run.status };
  }

  // 2. All-tasks-terminal check BEFORE the quota gate — if every task is
  //    already done/dropped there is nothing left to schedule and we must not
  //    write a pause checkpoint on a run that is effectively finished. An empty
  //    run (tasks: {}) is vacuously all-terminal — same semantics as the
  //    post-cascade check in step 6. (Mirrors stepTask's terminal-before-gate
  //    ordering; see the analogous task-level guard in coroutine.ts.)
  if (Object.values(run.tasks).every((t) => isTerminalTaskStatus(t.status))) {
    return { ...ctx(), kind: "all-terminal", cascade_dropped: [] };
  }

  // 3. Quota gate — a breach persists the checkpoint and stops cleanly. Workflow
  //    mode skips pacing (Decision 24); the gate reads run.mode to decide.
  const stop = await applyQuotaGate(deps, runId, run.mode);
  if (stop !== null) {
    return {
      ...ctx(),
      kind: "quota-blocked",
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
    return { ...ctx(), kind: "all-terminal", cascade_dropped: cascadeDropped };
  }

  // 7. Build the ready set: non-terminal tasks whose deps are all done.
  //    In-flight tasks (status !== "pending") come first — crash-resume finishes
  //    what was started before opening new work.
  const ready = tasks.filter((t) => !isTerminalTaskStatus(t.status) && depsSatisfied(run, t));
  const inFlight = ready.filter((t) => t.status !== "pending").map((t) => t.task_id);
  const pending = ready.filter((t) => t.status === "pending").map((t) => t.task_id);
  const ordered = [...inFlight, ...pending];

  if (ordered.length === 0) {
    // Circuit breaker (Decision 34): no task is actionable yet non-terminal work
    // remains — a dependency cycle / mutually-stuck graph that no future iteration
    // can resolve. Rather than throw (anti-spin), DROP each wedged task as a
    // spec-defect and fall through to all-terminal → finalize → `failed` (develop
    // stays clean). LOUD: every drop is recorded with its reason (dropTask warns).
    const wedged = tasks.filter((t) => !isTerminalTaskStatus(t.status));
    const detail = wedged.map((t) => `${t.task_id}=${t.status}`).join(", ");
    for (const t of wedged) {
      await dropTask(
        deps,
        runId,
        t.task_id,
        "spec-defect",
        `unrunnable: no ready task and no satisfiable path (dependency cycle/deadlock) — wedged set [${detail}]`,
      );
      cascadeDropped.push(t.task_id);
    }
    run = await deps.state.read(runId);
    return { ...ctx(), kind: "all-terminal", cascade_dropped: cascadeDropped };
  }

  return { ...ctx(), kind: "tasks-ready", ready: ordered, cascade_dropped: cascadeDropped };
}
