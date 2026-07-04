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

import { applyRescue, resetTaskRow } from "./apply.js";
import { StateManager } from "../core/state/manager.js";
import { isTerminalRunStatus } from "../core/state/schema.js";
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
      ...(status !== undefined
        ? {
            status,
            ...(isTerminalRunStatus(status) ? { ended_at: "2026-06-08T00:00:00.000Z" } : {}),
          }
        : {}),
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

  it("resetE2e:true clears a failed e2e_phase verdict and reopens the run even with NO resettable tasks (Decision 39 repair path)", async () => {
    // Every task shipped `done` (e.g. the e2e phase failed on a reopen-cap
    // exhaustion or an unmappable/tooling failure AFTER all tasks had already
    // completed) — scanRun sees nothing wrong with the tasks themselves, so a
    // plain rescue apply would find zero resettable targets and never reopen.
    await seed([{ task_id: "a", status: "done" }], "failed");
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e_phase: {
        status: "failed",
        reason: "e2e reopen cap (2) exhausted for task(s): a",
        manifest: [{ task_ids: ["a"], spec_path: "checkout.spec.ts", kind: "critical" }],
        reopen_counts: { a: 2 },
      },
    }));

    const result = await applyRescue(state, RUN_ID, { resetE2e: true });
    expect(result.reopened).toBe(true);
    expect(result.run_status).toBe("running");

    const run = await state.read(RUN_ID);
    expect(run.status).toBe("running");
    expect(run.e2e_phase?.status).toBeUndefined();
    expect(run.e2e_phase?.reason).toBeUndefined();
    // History the cadence/cap logic depends on survives the reset.
    expect(run.e2e_phase?.manifest).toHaveLength(1);
    expect(run.e2e_phase?.reopen_counts).toEqual({ a: 2 });
  });

  it("resetE2e:true preserves author_attempts through the reopen (D5 history — the author-retry cap survives a rescue, like reopen_counts)", async () => {
    await seed([{ task_id: "a", status: "done" }], "failed");
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e_phase: {
        status: "failed",
        reason: "e2e reopen cap (2) exhausted for task(s): a",
        manifest: [{ task_ids: ["a"], spec_path: "checkout.spec.ts", kind: "critical" }],
        reopen_counts: { a: 2 },
        author_attempts: 1,
      },
    }));

    const result = await applyRescue(state, RUN_ID, { resetE2e: true });
    expect(result.reopened).toBe(true);

    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.status).toBeUndefined();
    expect(run.e2e_phase?.author_attempts).toBe(1);
  });

  it("resetE2e:true DROPS a live adjudication cursor (dead worktree) but PRESERVES adjudication_counts (D7 cap history)", async () => {
    await seed([{ task_id: "a", status: "done" }], "failed");
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e_phase: {
        status: "failed",
        reason: "e2e-adjudicator: unparseable producer status: gibberish (after 2 attempts)",
        manifest: [{ task_ids: ["a"], spec_path: "checkout.spec.ts", kind: "critical" }],
        reopen_counts: {},
        adjudication: {
          specs: [{ spec_path: "e2e/legacy.spec.ts", title: "legacy journey", mode: "adjudicate" }],
          attempts: 1,
          requested_at: "2026-07-03T00:00:00.000Z",
        },
        adjudication_counts: { "e2e/old.spec.ts": 1 },
      },
    }));

    const result = await applyRescue(state, RUN_ID, { resetE2e: true });
    expect(result.reopened).toBe(true);

    const run = await state.read(RUN_ID);
    expect(run.e2e_phase?.status).toBeUndefined();
    expect(run.e2e_phase?.adjudication).toBeUndefined();
    expect(run.e2e_phase?.adjudication_counts).toEqual({ "e2e/old.spec.ts": 1 });
  });

  it("resetE2e:true on a PRE-authoring failure (empty manifest) clears e2e_phase entirely so the author re-spawns, instead of leaving a false-done empty-manifest phase", async () => {
    // The author crashed/timed out/emitted an unparseable status before ANY
    // manifest was produced — markFailed writes status:"failed" with manifest:[].
    // A plain reopen that PRESERVED the empty manifest would leave `e2e_phase`
    // defined, so `runE2eEmit`'s `run.e2e_phase === undefined` re-authoring gate
    // would never re-fire — the next pass would hit `runSuiteAndDecide`'s
    // empty-manifest branch and silently `markDone` with zero coverage.
    await seed([{ task_id: "a", status: "done" }], "failed");
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e_phase: {
        status: "failed",
        reason: "e2e-author: no parseable status",
        manifest: [],
        reopen_counts: {},
      },
    }));

    const result = await applyRescue(state, RUN_ID, { resetE2e: true });
    expect(result.reopened).toBe(true);
    expect(result.run_status).toBe("running");

    const run = await state.read(RUN_ID);
    expect(run.status).toBe("running");
    // The whole phase is gone (not merely status-cleared) — `runE2eEmit`'s
    // `run.e2e_phase === undefined` gate must see it as truly unset.
    expect(run.e2e_phase).toBeUndefined();
  });

  it("resetE2e:true drops a FAILED e2e_assessment entirely (Decision 40) so the assessor re-fires fresh; swept tasks reset by the default path", async () => {
    // The assessment condemned the run: swept tasks blocked-environmental, then failed.
    await seed(
      [{ task_id: "a", status: "failed", failure_class: "blocked-environmental" }],
      "failed",
    );
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e: true,
      e2e_assessment: {
        status: "failed" as const,
        reason: "the app cannot boot",
        affected_specs: [],
        attempts: 2,
      },
    }));

    const result = await applyRescue(state, RUN_ID, { resetE2e: true });
    expect(result.reopened).toBe(true);
    expect(result.reset).toEqual(["a"]); // the swept task is recoverable by default

    const run = await state.read(RUN_ID);
    expect(run.status).toBe("running");
    // WHOLE object dropped — wantsE2eAssessment's `status !== undefined` gate must
    // see it as never-run (unlike e2e_phase, there is no manifest worth keeping).
    expect(run.e2e_assessment).toBeUndefined();
    expect(run.tasks["a"]?.status).toBe("pending");
  });

  it("resetE2e:true reopens on a failed assessment ALONE (every task done — the resumed pre-M2 edge)", async () => {
    await seed([{ task_id: "a", status: "done" }], "failed");
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e: true,
      e2e_assessment: {
        status: "failed" as const,
        reason: "the app cannot boot",
        affected_specs: [],
      },
    }));

    const result = await applyRescue(state, RUN_ID, { resetE2e: true });
    expect(result.reopened).toBe(true);
    expect(result.reset).toEqual([]);
    expect((await state.read(RUN_ID)).e2e_assessment).toBeUndefined();
  });

  it("without resetE2e, a failed e2e_assessment is left untouched (no silent auto-retry)", async () => {
    await seed([{ task_id: "a", status: "done" }], "failed");
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e: true,
      e2e_assessment: {
        status: "failed" as const,
        reason: "the app cannot boot",
        affected_specs: [],
      },
    }));

    const result = await applyRescue(state, RUN_ID);
    expect(result.reopened).toBe(false);
    expect((await state.read(RUN_ID)).e2e_assessment?.status).toBe("failed");
  });

  it("resetE2e:true leaves a DONE assessment alone (only failed is droppable)", async () => {
    await seed([{ task_id: "a", status: "done" }], "failed");
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e: true,
      e2e_assessment: { status: "done" as const, affected_specs: [] },
      e2e_phase: {
        status: "failed" as const,
        reason: "e2e reopen cap (2) exhausted for task(s): a",
        manifest: [{ task_ids: ["a"], spec_path: "checkout.spec.ts", kind: "critical" as const }],
        reopen_counts: { a: 2 },
      },
    }));

    const result = await applyRescue(state, RUN_ID, { resetE2e: true });
    expect(result.reopened).toBe(true); // via the failed e2e_phase
    const run = await state.read(RUN_ID);
    expect(run.e2e_assessment?.status).toBe("done"); // forecast + machinery preserved
    expect(run.e2e_phase?.status).toBeUndefined();
  });

  it("recheckRollup:true reopens a completed run whose rollup armed but never landed, even with NO resettable tasks (finding #5 repair path)", async () => {
    // Every task shipped `done` — scanRun sees nothing wrong with the tasks
    // themselves, so a plain rescue apply would find zero resettable targets and
    // never reopen. Only the run-level rollup pointer says there's work left.
    await seed([{ task_id: "a", status: "done" }], "completed");
    await state.update(RUN_ID, (s) => ({
      ...s,
      rollup: { number: 42, merged: false, reason: "auto-armed" },
    }));

    const result = await applyRescue(state, RUN_ID, { recheckRollup: true });
    expect(result.reopened).toBe(true);
    expect(result.run_status).toBe("running");

    const run = await state.read(RUN_ID);
    expect(run.status).toBe("running");
    // apply does not touch the rollup pointer itself — finalize re-derives (and
    // clears, on merge) it on the re-drive.
    expect(run.rollup).toEqual({ number: 42, merged: false, reason: "auto-armed" });
  });

  it("without recheckRollup, a pending rollup is left untouched (no silent auto-recheck)", async () => {
    await seed([{ task_id: "a", status: "done" }], "completed");
    await state.update(RUN_ID, (s) => ({
      ...s,
      rollup: { number: 42, merged: false, reason: "auto-armed" },
    }));

    const result = await applyRescue(state, RUN_ID);
    expect(result.reopened).toBe(false);
    expect(result.run_status).toBe("completed");

    const run = await state.read(RUN_ID);
    expect(run.status).toBe("completed");
    expect(run.rollup).toEqual({ number: 42, merged: false, reason: "auto-armed" });
  });

  it("recheckRollup:true is a no-op when the run has no rollup pointer (nothing to recheck)", async () => {
    await seed([{ task_id: "a", status: "done" }], "completed");

    const result = await applyRescue(state, RUN_ID, { recheckRollup: true });
    expect(result.reopened).toBe(false);
    expect(result.run_status).toBe("completed");
  });

  it("without resetE2e, a failed e2e_phase verdict is left untouched (no silent auto-retry)", async () => {
    await seed([{ task_id: "a", status: "done" }], "failed");
    await state.update(RUN_ID, (s) => ({
      ...s,
      e2e_phase: {
        status: "failed",
        reason: "e2e reopen cap (2) exhausted for task(s): a",
        manifest: [],
        reopen_counts: { a: 2 },
      },
    }));

    const result = await applyRescue(state, RUN_ID);
    expect(result.reopened).toBe(false);
    expect(result.run_status).toBe("failed");

    const run = await state.read(RUN_ID);
    expect(run.status).toBe("failed");
    expect(run.e2e_phase?.status).toBe("failed");
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

  it("a plain rescue reset carries forward the task's existing e2e_feedback unchanged", async () => {
    await seed([
      {
        task_id: "d",
        status: "executing",
        phase: "verify",
        e2e_feedback: "checkout: expected order confirmation, got 500",
      },
    ]);

    await applyRescue(state, RUN_ID);

    const run = await state.read(RUN_ID);
    expect(run.tasks.d!.e2e_feedback).toBe("checkout: expected order confirmation, got 500");
  });

  describe("auto (the bounded self-heal path — `factory recover --auto`, S10 / Decision 48)", () => {
    const AT = "2026-07-04T00:00:00.000Z";

    it("resets the EFFECTIVE set only, stamps self_heal in the same write, and reopens", async () => {
      await seed(
        [
          { task_id: "dead", status: "failed", failure_class: "spec-defect" },
          {
            task_id: "doomed",
            status: "failed",
            failure_class: "blocked-environmental",
            depends_on: ["dead"],
          },
          { task_id: "fine", status: "failed", failure_class: "blocked-environmental" },
        ],
        "failed",
      );

      const result = await applyRescue(state, RUN_ID, { auto: { at: AT } });
      expect(result.reset).toEqual(["fine"]); // doomed excluded: dep on a dead-end
      expect(result.reopened).toBe(true);
      expect(result.run_status).toBe("running");
      expect(result.auto_blocked).toBeUndefined();
      expect(result.self_heal_attempts).toBe(1);

      const run = await state.read(RUN_ID);
      expect(run.self_heal).toEqual({ attempts: 1, last_at: AT });
      expect(run.status).toBe("running");
      expect(run.tasks.fine!.status).toBe("pending");
      expect(run.tasks.doomed!.status).toBe("failed"); // untouched — would just re-cascade
      expect(run.tasks.dead!.status).toBe("failed");
    });

    it("requires attempts === 0: a second auto is a no-op flagged auto_blocked:'attempts'", async () => {
      await seed(
        [{ task_id: "a", status: "failed", failure_class: "blocked-environmental" }],
        "failed",
      );
      await applyRescue(state, RUN_ID, { auto: { at: AT } });
      // The re-driven task fails again and the run re-finalizes to failed.
      await state.update(RUN_ID, (s) => ({
        ...s,
        status: "failed",
        ended_at: "2026-07-04T01:00:00.000Z",
        tasks: {
          a: task({ task_id: "a", status: "failed", failure_class: "blocked-environmental" }),
        },
      }));

      const second = await applyRescue(state, RUN_ID, { auto: { at: "2026-07-04T02:00:00.000Z" } });
      expect(second.auto_blocked).toBe("attempts");
      expect(second.reset).toEqual([]);
      expect(second.reopened).toBe(false);
      expect(second.run_status).toBe("failed");

      const run = await state.read(RUN_ID);
      expect(run.self_heal).toEqual({ attempts: 1, last_at: AT }); // NOT re-stamped
      expect(run.status).toBe("failed");
      expect(run.tasks.a!.status).toBe("failed");
    });

    it("auto with an empty effective set is a no-op flagged 'empty' and does NOT stamp self_heal", async () => {
      await seed([{ task_id: "dead", status: "failed", failure_class: "spec-defect" }], "failed");

      const result = await applyRescue(state, RUN_ID, { auto: { at: AT } });
      expect(result.auto_blocked).toBe("empty");
      expect(result.reset).toEqual([]);
      expect(result.reopened).toBe(false);
      expect(result.run_status).toBe("failed");
      expect((await state.read(RUN_ID)).self_heal).toBeUndefined();
    });

    it("auto never touches a failed e2e verdict (task-level, state-only — no silent e2e retry)", async () => {
      await seed([{ task_id: "a", status: "done" }], "failed");
      await state.update(RUN_ID, (s) => ({
        ...s,
        e2e_phase: { status: "failed", reason: "cap exhausted", manifest: [], reopen_counts: {} },
      }));

      const result = await applyRescue(state, RUN_ID, { auto: { at: AT } });
      expect(result.auto_blocked).toBe("empty");
      expect((await state.read(RUN_ID)).e2e_phase?.status).toBe("failed");
    });

    it("auto is mutually exclusive with the manual target options (loud throw)", async () => {
      await seed([{ task_id: "a", status: "executing" }]);
      await expect(
        applyRescue(state, RUN_ID, { auto: { at: AT }, includeDeadEnds: true }),
      ).rejects.toThrow(/mutually exclusive/);
    });
  });
});

describe("resetTaskRow (Decision 39 — e2e reopen reuse)", () => {
  function task(
    seed: Partial<TaskState> & { task_id: string; status: TaskState["status"] },
  ): TaskState {
    return {
      depends_on: [],
      escalation_rung: 2,
      reviewers: [{ reviewer: "security", verdict: "approve", confirmed_blockers: 0 }],
      merge_resyncs: 1,
      ...seed,
    };
  }

  it("drops test_revision_feedback (unrelated intra-attempt note) on every reset", () => {
    const reset = resetTaskRow(
      task({ task_id: "a", status: "shipping", test_revision_feedback: "stale" }),
    );
    expect(reset.test_revision_feedback).toBeUndefined();
  });

  it("with no opts, carries forward an existing e2e_feedback unchanged", () => {
    const reset = resetTaskRow(
      task({ task_id: "a", status: "shipping", e2e_feedback: "checkout: 500 on submit" }),
    );
    expect(reset.e2e_feedback).toBe("checkout: 500 on submit");
  });

  it("with no prior e2e_feedback and no opts, stays absent", () => {
    const reset = resetTaskRow(task({ task_id: "a", status: "shipping" }));
    expect(reset.e2e_feedback).toBeUndefined();
  });

  it("opts.e2eFeedback OVERWRITES any existing e2e_feedback — the e2e reopen path", () => {
    const reset = resetTaskRow(
      task({ task_id: "a", status: "shipping", e2e_feedback: "old note" }),
      {
        e2eFeedback: "checkout: expected order confirmation, got 500",
      },
    );
    expect(reset.e2e_feedback).toBe("checkout: expected order confirmation, got 500");
  });

  it("opts.e2eFeedback SETS a fresh value even with no prior feedback", () => {
    const reset = resetTaskRow(task({ task_id: "a", status: "shipping" }), {
      e2eFeedback: "login: 403 on submit",
    });
    expect(reset.e2e_feedback).toBe("login: 403 on submit");
  });

  it("still resets status/escalation/reviewers/merge_resyncs alongside an e2e feedback set", () => {
    const reset = resetTaskRow(task({ task_id: "a", status: "shipping" }), { e2eFeedback: "x" });
    expect(reset.status).toBe("pending");
    expect(reset.escalation_rung).toBe(0);
    expect(reset.reviewers).toEqual([]);
    expect(reset.merge_resyncs).toBe(0);
  });
});
