/**
 * The RUN-LEVEL COROUTINE — the engine half of the `factory next-task` seam.
 *
 * One invocation = one run-loop iteration: terminal check → quota gate (persisting
 * pause/suspend) → checkpoint clear on recovery → cascade-fail (transitive,
 * blocked-environmental) → the READY set. Ready = every NON-TERMINAL task whose
 * deps are all `done` — in-flight tasks come first so a crashed runner finishes
 * what it started before opening new work.
 *
 * Circuit breaker (Decision 34): when no task is actionable yet non-terminal work
 * remains (dependency cycle / mutually-stuck graph), each wedged task is failed as
 * `spec-defect` and the envelope `all-terminal` is returned. The orchestrator routes this
 * to finalize → `failed`, leaving `develop` clean. Every fail is LOUD (failTask
 * warns) with the full wedged set in the reason.
 *
 * Ordering invariant: terminal-run check BEFORE the quota gate — a terminal probe
 * must not write a pause checkpoint (same discipline as nextAction in orchestrator.ts).
 *
 * Clearing a stale paused/suspended checkpoint on recovery is THIS CALLER's job
 * (the quota gate doc is explicit: "on proceed the gate never writes state;
 * clearing a stale checkpoint on recovery is the CALLER's job").
 *
 * Single-writer assumption: lock-free snapshot reads are sound because v1 has
 * exactly one orchestrator process writing state; subagents never write run state.
 *
 * `cascade_failed` on the `all-terminal` variant is THIS-INVOCATION-ONLY — it
 * lists tasks failed by the cascade loop in this call. Authoritative fail
 * visibility lives in run state (task.status === "failed") and the finalize
 * rollup.
 */
import {
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
  isTerminalTaskStatus,
  clearCheckpoint,
  decideFinalize,
  type RunState,
  type TaskState,
} from "./deps.js";
import { failTask } from "./transitions.js";
import { MAX_DOCS_ATTEMPTS } from "./docs.js";
import { applyQuotaGate, type QuotaStop } from "./quota-gate.js";
import { applyCircuitBreaker } from "./circuit-breaker-gate.js";
import type { OrchestratorDeps } from "./orchestrator.js";

/**
 * Every variant carries the run's self-resolved context — `run_id`, the canonical
 * `data_dir` (from {@link resolveDataDir}), and the persisted `ship_mode`. The
 * workflow runner adopts these from the FIRST envelope instead of having
 * them marshaled through Workflow `args` (a real object passed as `args` arrives
 * JSON-string-encoded, so a load-bearing arg silently becomes `undefined`).
 */
type NextContext = {
  readonly run_id: string;
  readonly data_dir: string;
  readonly ship_mode: RunState["ship_mode"];
};

export type NextTask =
  | (NextContext & {
      readonly kind: "work";
      readonly ready: readonly string[];
      readonly cascade_failed: readonly string[];
    })
  | (NextContext & {
      readonly kind: "finalize";
      /** Tasks failed by the cascade loop in THIS invocation (not cumulative). */
      readonly cascade_failed: readonly string[];
    })
  | (NextContext & {
      readonly kind: "document";
    })
  | (NextContext & {
      readonly kind: "done";
      readonly run_status: (typeof TERMINAL_RUN_STATUSES)[number];
    })
  | (NextContext & {
      readonly kind: "pause";
      readonly scope: QuotaStop["scope"];
      readonly reason: string;
      readonly resets_at_epoch?: number;
    });

/** True iff every dependency of `task` is `done`. */
function depsSatisfied(run: RunState, task: TaskState): boolean {
  return task.depends_on.every((d) => run.tasks[d]?.status === "done");
}

/** A dependency is unsatisfiable when it is absent or already failed. */
function isUnsatisfiableDep(run: RunState, depId: string): boolean {
  const dep = run.tasks[depId];
  return dep === undefined || dep.status === "failed";
}

/**
 * True iff a fully-terminal run still needs its docs phase: prospective status
 * `completed`, docs not already `done`, and docs applicable to the target repo.
 * The caller MUST guarantee all tasks are terminal — decideFinalize throws otherwise.
 */
async function wantsDocs(deps: OrchestratorDeps, run: RunState): Promise<boolean> {
  if (run.docs?.status === "done") return false;
  if ((run.docs?.attempts ?? 0) >= MAX_DOCS_ATTEMPTS) return false; // cap: treat docs as done
  if (decideFinalize(run).run_status !== "completed") return false;
  return deps.docsApplicable();
}

export async function nextTask(deps: OrchestratorDeps, runId: string): Promise<NextTask> {
  let run = await deps.state.read(runId);

  // Self-resolved run context stamped onto EVERY envelope variant (so the workflow
  // orchestrator adopts run_id/data_dir/ship_mode from the first `next`, never from args).
  // `data_dir`/`ship_mode` are immutable for the run; reading the current `run`
  // snapshot at call time is always correct even after the cascade re-reads `run`.
  const ctx = () => ({ run_id: runId, data_dir: deps.dataDir, ship_mode: run.ship_mode });

  // 1. Terminal run check BEFORE the quota gate — a finished run must never
  //    write a pause checkpoint (mirrors nextAction in orchestrator.ts).
  if (isTerminalRunStatus(run.status)) {
    return { ...ctx(), kind: "done", run_status: run.status };
  }

  // 2. All-tasks-terminal check BEFORE the quota gate. A GENUINELY finished run
  //    early-returns here (a finished run must never write a pause checkpoint). But a
  //    run whose tasks are all terminal yet whose docs phase is still pending is NOT
  //    finished: it falls through to the quota gate + checkpoint clear so a
  //    docs-suspended run resumes cleanly, then returns `docs-ready` after step 4.
  const allTerminal = Object.values(run.tasks).every((t) => isTerminalTaskStatus(t.status));
  const needsDocs = allTerminal && (await wantsDocs(deps, run));
  if (allTerminal && !needsDocs) {
    // Clear quota checkpoint before finalizing: a paused run whose tasks all complete
    // bypasses the step-4 clear below. Without this, a stop between this return and
    // factory-run-finalize strands the run as paused (stop-gate returns ALLOW for
    // non-running, so it never self-finalizes). Mirrors next.ts:149-155.
    if (run.status === "paused" || run.status === "suspended") {
      const patch = clearCheckpoint();
      await deps.state.update(runId, (s) => ({ ...s, status: patch.status, quota: patch.quota }));
    }
    return { ...ctx(), kind: "finalize", cascade_failed: [] };
  }

  // 3. Quota gate — a breach persists the checkpoint and stops cleanly. Workflow
  //    mode and --ignore-quota skip pacing (Decision 24).
  const stop = await applyQuotaGate(deps, runId, run.mode, run.ignore_quota);
  if (stop !== null) {
    return {
      ...ctx(),
      kind: "pause",
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

  // Docs gate: a completed run with a pending, applicable docs phase. Reached only
  // when `needsDocs` (all tasks terminal), and AFTER the checkpoint clear so a
  // docs-suspended run is back to `running` first. `needsDocs` was computed from the
  // entry snapshot; the checkpoint clear changes only status/quota, never tasks/docs.
  if (needsDocs) {
    return { ...ctx(), kind: "document" };
  }

  // 5. Cascade-fail until stable. Pending tasks with an unsatisfiable dep are
  //    failed as blocked-environmental; a fail can expose further blocked tasks.
  const cascadeFailed: string[] = [];
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
      await failTask(
        deps,
        runId,
        t.task_id,
        "blocked-environmental",
        `dependency '${unsatisfied}' did not complete (failed or missing)`,
      );
      cascadeFailed.push(t.task_id);
    }
  }
  // `run` is fresh from the loop's last read (no writes since the loop exited).

  // 6. All-tasks-terminal after cascade — the cascade may have resolved the run.
  const tasks = Object.values(run.tasks);

  if (tasks.every((t) => isTerminalTaskStatus(t.status))) {
    return { ...ctx(), kind: "finalize", cascade_failed: cascadeFailed };
  }

  // 6b. Run-level circuit breaker (WS4) — a HARD run-abort guard, distinct from both
  //     the recoverable quota pause and the Decision-34 wedge-fail below. Trips on
  //     genuine repeated capability failures (BOTH modes) or — workflow only — the
  //     runtime ceiling (see circuit-breaker-gate.ts for why session disarms runtime).
  //     Placed AFTER the terminal checks (never abort an already-finished run; never
  //     write on a terminal run) and AFTER the quota gate (a paused run early-returns
  //     above, so quota waiting never trips the breaker). On a trip, fail every
  //     remaining non-terminal task LOUD (capability-budget, breaker reason carried)
  //     and fall through to all-terminal → finalize → `failed`, reusing the wedge-fail
  //     path — so no new envelope kind or orchestrator change is needed.
  const breaker = await applyCircuitBreaker(deps, runId);
  if (breaker !== null) {
    for (const t of tasks.filter((x) => !isTerminalTaskStatus(x.status))) {
      await failTask(
        deps,
        runId,
        t.task_id,
        "capability-budget",
        `circuit breaker tripped: ${breaker.reason}`,
      );
      cascadeFailed.push(t.task_id);
    }
    run = await deps.state.read(runId);
    return { ...ctx(), kind: "finalize", cascade_failed: cascadeFailed };
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
    // stays clean). LOUD: every fail is recorded with its reason (failTask warns).
    const wedged = tasks.filter((t) => !isTerminalTaskStatus(t.status));
    const detail = wedged.map((t) => `${t.task_id}=${t.status}`).join(", ");
    for (const t of wedged) {
      await failTask(
        deps,
        runId,
        t.task_id,
        "spec-defect",
        `unrunnable: no ready task and no satisfiable path (dependency cycle/deadlock) — wedged set [${detail}]`,
      );
      cascadeFailed.push(t.task_id);
    }
    run = await deps.state.read(runId);
    return { ...ctx(), kind: "finalize", cascade_failed: cascadeFailed };
  }

  return { ...ctx(), kind: "work", ready: ordered, cascade_failed: cascadeFailed };
}
