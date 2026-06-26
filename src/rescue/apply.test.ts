/**
 * WS12 — rescue APPLY (the writer; Decision 22, Δ S).
 *
 * Exercises {@link applyRescue} against the real {@link StateManager} (temp dir):
 *   - resets stuck (crashed in-flight) + recoverable (blocked-environmental) tasks
 *     to a clean `pending`, clearing the stale producer/reviewer/fail state but
 *     PRESERVING the git/PR pointers;
 *   - leaves dead-end failures (spec-defect/capability-budget) failed by default,
 *     resetting them only with `includeDeadEnds`;
 *   - never resets a `done` task (default skips it; an explicit --task is a throw);
 *   - reopens a TERMINAL run to `running` when it reset work; leaves a non-terminal
 *     quota state (suspended) untouched so `run resume` clears it;
 *   - explicit `tasks` override: missing→throw, done→throw, pending→skipped;
 *   - is idempotent (a second apply is a no-op, reopened:false).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyRescue } from "./apply.js";
import { StateManager } from "../core/state/manager.js";
import type { RunStatus, TaskState } from "../types/index.js";

const RUN_ID = "run-rescue-1";
const SPEC = { repo: "acme/widgets", spec_id: "7-x", issue_number: 7 } as const;

type TaskSeed = Partial<TaskState> & { task_id: string; status: TaskState["status"] };

function task(seed: TaskSeed): TaskState {
  const base = {
    depends_on: [],
    risk_tier: "medium" as const,
    escalation_rung: 0,
    reviewers: [],
    merge_resyncs: 0,
    ...seed,
  };
  if (seed.status === "failed") {
    return {
      failure_class: "capability-budget" as const,
      failure_reason: "ran out of retries",
      ...base,
    };
  }
  return base;
}

describe("applyRescue", () => {
  let dataDir: string;
  let state: StateManager;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-rescue-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    await state.create({ run_id: RUN_ID, spec: SPEC });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Seed the run's task rows (and optionally its status) in one write. */
  async function seed(seeds: readonly TaskSeed[], status?: RunStatus): Promise<void> {
    await state.update(RUN_ID, (s) => ({
      ...s,
      ...(status !== undefined ? { status } : {}),
      tasks: Object.fromEntries(seeds.map((t) => [t.task_id, task(t)])),
    }));
  }

  it("resets a stuck in-flight task to a clean pending, preserving the PR pointers", async () => {
    await seed([
      {
        task_id: "a",
        status: "shipping",
        escalation_rung: 2,
        producer_role: "implementer",
        branch: "factory/run/a",
        pr_number: 9,
        reviewers: [{ reviewer: "security", verdict: "approve", confirmed_blockers: 0 }],
        started_at: "2026-06-08T00:00:00.000Z",
      },
    ]);

    const result = await applyRescue(state, RUN_ID);

    expect(result.reset).toEqual(["a"]);
    expect(result.reopened).toBe(false); // run was 'running', not terminal
    expect(result.run_status).toBe("running");

    const a = (await state.read(RUN_ID)).tasks.a!;
    expect(a.status).toBe("pending");
    expect(a.escalation_rung).toBe(0);
    expect(a.reviewers).toEqual([]);
    expect(a.producer_role).toBeUndefined();
    expect(a.started_at).toBeUndefined();
    // PR pointers preserved → the next attempt reuses the branch/PR (idempotent-create).
    expect(a.branch).toBe("factory/run/a");
    expect(a.pr_number).toBe(9);
  });

  it("resets a recoverable (blocked-environmental) fail, clearing the classification", async () => {
    await seed([{ task_id: "b", status: "failed", failure_class: "blocked-environmental" }]);

    const result = await applyRescue(state, RUN_ID);

    expect(result.reset).toEqual(["b"]);
    const b = (await state.read(RUN_ID)).tasks.b!;
    expect(b.status).toBe("pending");
    expect(b.failure_class).toBeUndefined();
    expect(b.failure_reason).toBeUndefined();
  });

  it("leaves dead-end failures failed by default, but resets them with includeDeadEnds", async () => {
    await seed([
      { task_id: "spec", status: "failed", failure_class: "spec-defect" },
      { task_id: "cap", status: "failed", failure_class: "capability-budget" },
    ]);

    const def = await applyRescue(state, RUN_ID);
    expect(def.reset).toEqual([]); // dead-ends untouched
    expect((await state.read(RUN_ID)).tasks.spec!.status).toBe("failed");

    const forced = await applyRescue(state, RUN_ID, { includeDeadEnds: true });
    expect(forced.reset).toEqual(["spec", "cap"]);
    expect((await state.read(RUN_ID)).tasks.spec!.status).toBe("pending");
    expect((await state.read(RUN_ID)).tasks.cap!.status).toBe("pending");
  });

  it("never resets a done task by default (would un-ship)", async () => {
    await seed([
      { task_id: "done", status: "done", pr_number: 11 },
      { task_id: "stuck", status: "executing" },
    ]);

    const result = await applyRescue(state, RUN_ID);
    expect(result.reset).toEqual(["stuck"]);
    expect((await state.read(RUN_ID)).tasks.done!.status).toBe("done");
  });

  it("reopens a terminal failed run to running when it reset work", async () => {
    await seed(
      [
        { task_id: "a", status: "done", pr_number: 11 },
        { task_id: "b", status: "failed", failure_class: "blocked-environmental" },
      ],
      "failed",
    );

    const result = await applyRescue(state, RUN_ID);
    expect(result.reopened).toBe(true);
    expect(result.run_status).toBe("running");
    expect(result.reset).toEqual(["b"]);

    const run = await state.read(RUN_ID);
    expect(run.status).toBe("running");
    expect(run.ended_at).toBeNull();
  });

  it("leaves a suspended run suspended (so run resume clears the quota gate)", async () => {
    // Seed a suspended run carrying a quota checkpoint + a stuck task.
    await state.update(RUN_ID, (s) => ({
      ...s,
      status: "suspended",
      quota: { binding_window: "7d" },
      tasks: { a: task({ task_id: "a", status: "executing" }) },
    }));

    const result = await applyRescue(state, RUN_ID);
    expect(result.reset).toEqual(["a"]);
    expect(result.reopened).toBe(false);
    expect(result.run_status).toBe("suspended");

    const run = await state.read(RUN_ID);
    expect(run.status).toBe("suspended");
    expect(run.quota).toEqual({ binding_window: "7d" }); // checkpoint preserved for resume
    expect(run.tasks.a!.status).toBe("pending");
  });

  it("is idempotent: a second apply resets nothing and does not reopen", async () => {
    await seed(
      [
        { task_id: "a", status: "done", pr_number: 11 },
        { task_id: "b", status: "failed", failure_class: "blocked-environmental" },
      ],
      "failed",
    );

    const first = await applyRescue(state, RUN_ID);
    expect(first.reset).toEqual(["b"]);
    expect(first.reopened).toBe(true);

    const second = await applyRescue(state, RUN_ID);
    expect(second.reset).toEqual([]);
    expect(second.reopened).toBe(false);
    expect(second.run_status).toBe("running");
  });

  describe("explicit --task selection", () => {
    it("resets a named dead-end (naming is the human assertion)", async () => {
      await seed([{ task_id: "spec", status: "failed", failure_class: "spec-defect" }]);

      const result = await applyRescue(state, RUN_ID, { tasks: ["spec"] });
      expect(result.reset).toEqual(["spec"]);
      expect((await state.read(RUN_ID)).tasks.spec!.status).toBe("pending");
    });

    it("throws on a named done task (would un-ship)", async () => {
      await seed([{ task_id: "a", status: "done", pr_number: 11 }]);
      await expect(applyRescue(state, RUN_ID, { tasks: ["a"] })).rejects.toThrow(/un-ship/);
      // state untouched.
      expect((await state.read(RUN_ID)).tasks.a!.status).toBe("done");
    });

    it("throws on a named missing task", async () => {
      await seed([{ task_id: "a", status: "executing" }]);
      await expect(applyRescue(state, RUN_ID, { tasks: ["ghost"] })).rejects.toThrow(
        /no task 'ghost'/,
      );
    });

    it("skips a named task that is already pending", async () => {
      await seed([
        { task_id: "p", status: "pending" },
        { task_id: "s", status: "executing" },
      ]);

      const result = await applyRescue(state, RUN_ID, { tasks: ["p", "s"] });
      expect(result.skipped).toEqual(["p"]);
      expect(result.reset).toEqual(["s"]);
    });
  });

  it("reset clears the phase cursor and merge_resyncs", async () => {
    await seed([
      {
        task_id: "c",
        status: "executing",
        phase: "verify",
        merge_resyncs: 3,
        escalation_rung: 1,
      },
    ]);

    await applyRescue(state, RUN_ID);

    const run = await state.read(RUN_ID);
    const c = run.tasks.c!;
    expect(c.phase).toBeUndefined();
    expect(c.merge_resyncs).toBe(0);
  });
});
