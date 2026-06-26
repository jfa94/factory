/**
 * WS10 / Task C — unit tests for the SHARED deterministic transition logic
 * ({@link transitions.ts}). These are the per-task ladder + drop/complete writes
 * that the coroutine records through (`record.ts` / `coroutine.ts`), so they are tested here ONCE,
 * against a real {@link StateManager} (temp dir). The coroutine suite (`coroutine.test.ts`) is
 * the end-to-end regression guard; this suite pins
 * the units in isolation (every branch of escalateOrDrop / applyProducerOutcome /
 * classifyProducerFailure / markInFlight / completeTask / dropTask / dropStep).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  markInFlight,
  completeTask,
  dropTask,
  dropStep,
  escalateOrDrop,
  classifyProducerFailure,
  applyProducerOutcome,
  type TransitionDeps,
} from "./transitions.js";
import { StateManager } from "../core/state/manager.js";
import { ESCALATION_CAP } from "../producer/index.js";
import type { ClassifyDecision, ProducerOutcome } from "../producer/index.js";
import type { TaskState, TaskPhase } from "../types/index.js";

const RUN_ID = "run-1";

describe("driver transitions (shared loop + CLI ladder/drop logic)", () => {
  let dataDir: string;
  let state: StateManager;
  let deps: TransitionDeps;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-transitions-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    deps = { state };
    await state.create({
      run_id: RUN_ID,
      spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
    });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Seed one task row (schema-valid via StateManager.update). */
  async function seedTask(t: Partial<TaskState> & { task_id: string }) {
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: {
        ...s.tasks,
        [t.task_id]: {
          task_id: t.task_id,
          status: t.status ?? "pending",
          depends_on: t.depends_on ?? [],
          escalation_rung: t.escalation_rung ?? 0,
          reviewers: t.reviewers ?? [],
          merge_resyncs: t.merge_resyncs ?? 0,
          ...(t.started_at ? { started_at: t.started_at } : {}),
          ...(t.ended_at ? { ended_at: t.ended_at } : {}),
          ...(t.producer_role ? { producer_role: t.producer_role } : {}),
          ...(t.spawn_in_flight ? { spawn_in_flight: t.spawn_in_flight } : {}),
        },
      },
    }));
  }

  async function readTask(taskId: string): Promise<TaskState> {
    const run = await state.read(RUN_ID);
    const task = run.tasks[taskId];
    if (task === undefined) throw new Error(`test: task '${taskId}' missing`);
    return task;
  }

  // -- markInFlight ---------------------------------------------------------

  it("markInFlight maps each phase to its in-flight status and stamps started_at once", async () => {
    await seedTask({ task_id: "t1" });
    const cases: ReadonlyArray<[TaskPhase, TaskState["status"]]> = [
      ["preflight", "pending"],
      ["tests", "executing"],
      ["exec", "executing"],
      ["verify", "reviewing"],
      ["ship", "shipping"],
    ];
    let firstStamp: string | undefined;
    for (const [phase, status] of cases) {
      await markInFlight(deps, RUN_ID, "t1", phase);
      const task = await readTask("t1");
      expect(task.status).toBe(status);
      expect(task.started_at).toBeDefined();
      firstStamp ??= task.started_at;
      // started_at is stamped on first entry and never moves.
      expect(task.started_at).toBe(firstStamp);
    }
  });

  // -- completeTask ---------------------------------------------------------

  it("completeTask persists done + ended_at and returns a done step", async () => {
    await seedTask({ task_id: "t1", status: "shipping" });
    const step = await completeTask(deps, RUN_ID, "t1");

    expect(step).toEqual({ done: true, outcome: { outcome: "done" } });
    const task = await readTask("t1");
    expect(task.status).toBe("done");
    expect(task.ended_at).toBeDefined();
  });

  it("completeTask preserves a pre-existing ended_at (stamped once)", async () => {
    const ended = "2026-06-01T00:00:00.000Z";
    await seedTask({ task_id: "t1", status: "shipping", ended_at: ended });
    await completeTask(deps, RUN_ID, "t1");
    expect((await readTask("t1")).ended_at).toBe(ended);
  });

  it("completeTask clears any spawn_in_flight checkpoint (WS2 terminal hygiene)", async () => {
    await seedTask({
      task_id: "t1",
      status: "shipping",
      spawn_in_flight: { phase: "verify", rung: 0, tip_sha: "sha-tip" },
    });
    await completeTask(deps, RUN_ID, "t1");
    expect((await readTask("t1")).spawn_in_flight).toBeUndefined();
  });

  // -- dropTask / dropStep --------------------------------------------------

  it("dropTask persists the closed failure_class + reason (loud drop)", async () => {
    await seedTask({ task_id: "t1", status: "executing" });
    await dropTask(deps, RUN_ID, "t1", "spec-defect", "criterion self-contradictory");

    const task = await readTask("t1");
    expect(task.status).toBe("dropped");
    expect(task.failure_class).toBe("spec-defect");
    expect(task.failure_reason).toBe("criterion self-contradictory");
    expect(task.ended_at).toBeDefined();
  });

  it("dropTask clears any spawn_in_flight checkpoint (WS2 terminal hygiene)", async () => {
    await seedTask({
      task_id: "t1",
      status: "executing",
      spawn_in_flight: { phase: "exec", rung: 2, tip_sha: "sha-tip" },
    });
    await dropTask(deps, RUN_ID, "t1", "capability-budget", "cap reached");
    expect((await readTask("t1")).spawn_in_flight).toBeUndefined();
  });

  it("dropStep drops then returns the dropped outcome step", async () => {
    await seedTask({ task_id: "t1", status: "executing" });
    const step = await dropStep(deps, RUN_ID, "t1", "blocked-environmental", "ci down");

    expect(step).toEqual({
      done: true,
      outcome: { outcome: "dropped", failure_class: "blocked-environmental", reason: "ci down" },
    });
    expect((await readTask("t1")).status).toBe("dropped");
  });

  // -- escalateOrDrop -------------------------------------------------------

  it("escalateOrDrop on a drop decision is an immediate classified drop (no rung burn)", async () => {
    await seedTask({ task_id: "t1", status: "executing", escalation_rung: 0 });
    const decision: ClassifyDecision = {
      action: "drop",
      failureClass: "spec-defect",
      reason: "unworkable",
    };
    const step = await escalateOrDrop(deps, RUN_ID, "t1", decision, "exec");

    expect(step.done).toBe(true);
    const task = await readTask("t1");
    expect(task.status).toBe("dropped");
    expect(task.escalation_rung).toBe(0); // never escalated
  });

  it("escalateOrDrop on a retry below the cap bumps the rung, clears reviewers, resumes at the phase", async () => {
    await seedTask({
      task_id: "t1",
      status: "reviewing",
      escalation_rung: 0,
      reviewers: [{ reviewer: "quality-reviewer", verdict: "blocked", confirmed_blockers: 1 }],
    });
    const decision: ClassifyDecision = { action: "retry", reason: "merge gate blocked" };
    const step = await escalateOrDrop(deps, RUN_ID, "t1", decision, "exec");

    expect(step).toEqual({ done: false, phase: "exec" });
    const task = await readTask("t1");
    expect(task.escalation_rung).toBe(1);
    expect(task.reviewers).toEqual([]); // stale reviewers cleared so verify re-derives
  });

  it("escalateOrDrop on a retry AT the cap drops capability-budget (ladder owns the cap)", async () => {
    await seedTask({ task_id: "t1", status: "reviewing", escalation_rung: ESCALATION_CAP });
    const decision: ClassifyDecision = { action: "retry", reason: "still blocked" };
    const step = await escalateOrDrop(deps, RUN_ID, "t1", decision, "exec");

    expect(step.done).toBe(true);
    if (!step.done) throw new Error("unreachable");
    expect(step.outcome.outcome).toBe("dropped");
    if (step.outcome.outcome !== "dropped") throw new Error("unreachable");
    expect(step.outcome.failure_class).toBe("capability-budget");
    expect((await readTask("t1")).escalation_rung).toBe(ESCALATION_CAP); // not bumped past cap
  });

  it("escalateOrDrop throws loud if the task vanished mid-flight", async () => {
    const decision: ClassifyDecision = { action: "retry", reason: "x" };
    await expect(escalateOrDrop(deps, RUN_ID, "ghost", decision, "exec")).rejects.toThrow(
      /vanished/i,
    );
  });

  // -- classifyProducerFailure ----------------------------------------------

  it("classifyProducerFailure: blocked-escalate → drop spec-defect", () => {
    const d = classifyProducerFailure({ status: "blocked-escalate", reason: "unworkable" });
    expect(d).toEqual({
      action: "drop",
      failureClass: "spec-defect",
      reason: expect.stringContaining("unworkable"),
    });
  });

  it("classifyProducerFailure: needs-context and error → retry (capability)", () => {
    expect(classifyProducerFailure({ status: "needs-context", reason: "r1" }).action).toBe("retry");
    expect(classifyProducerFailure({ status: "error", reason: "r2" }).action).toBe("retry");
  });

  it("classifyProducerFailure throws if handed a done outcome", () => {
    expect(() => classifyProducerFailure({ status: "done" } as ProducerOutcome)).toThrow(/done/i);
  });

  // -- applyProducerOutcome -------------------------------------------------

  it("applyProducerOutcome on done records producer_role and advances to resumePhase", async () => {
    await seedTask({ task_id: "t1", status: "executing", escalation_rung: 0 });
    const step = await applyProducerOutcome(
      deps,
      RUN_ID,
      "t1",
      { role: "implementer", phase: "exec", resumePhase: "verify" },
      { status: "done" },
    );

    expect(step).toEqual({ done: false, phase: "verify" });
    const task = await readTask("t1");
    expect(task.producer_role).toBe("implementer");
    expect(task.escalation_rung).toBe(0); // a success never bumps the rung
  });

  it("applyProducerOutcome on a failure status escalates at the SAME producer phase", async () => {
    await seedTask({ task_id: "t1", status: "executing", escalation_rung: 0 });
    const outcome: ProducerOutcome = { status: "error", reason: "tool crashed" };
    const step = await applyProducerOutcome(
      deps,
      RUN_ID,
      "t1",
      { role: "implementer", phase: "exec", resumePhase: "verify" },
      outcome,
    );

    // error → retry → resumes at the producer phase (exec), rung bumped.
    expect(step).toEqual({ done: false, phase: "exec" });
    expect((await readTask("t1")).escalation_rung).toBe(1);
  });

  it("applyProducerOutcome on blocked-escalate drops immediately (spec-defect, no rung burn)", async () => {
    await seedTask({ task_id: "t1", status: "executing", escalation_rung: 0 });
    const outcome: ProducerOutcome = { status: "blocked-escalate", reason: "unworkable" };
    const step = await applyProducerOutcome(
      deps,
      RUN_ID,
      "t1",
      { role: "test-writer", phase: "tests", resumePhase: "exec" },
      outcome,
    );

    expect(step.done).toBe(true);
    if (!step.done) throw new Error("unreachable");
    if (step.outcome.outcome !== "dropped") throw new Error("unreachable");
    expect(step.outcome.failure_class).toBe("spec-defect");
    expect((await readTask("t1")).escalation_rung).toBe(0);
  });

  // -- markInFlight phase cursor persistence --------------------------------

  it("markInFlight persists the precise phase cursor", async () => {
    await seedTask({ task_id: "t1" });
    await markInFlight({ state }, RUN_ID, "t1", "exec");
    const run = await state.read(RUN_ID);
    expect(run.tasks["t1"]?.status).toBe("executing");
    expect(run.tasks["t1"]?.phase).toBe("exec");
  });
});
