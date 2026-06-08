/**
 * `factory record-producer` (C5) — fold a producer spawn outcome into state via the
 * SHARED ladder (Δ D / Decision 25).
 *
 * arg/usage edges via {@link recordProducerCommand}; the fold via
 * {@link applyRecordProducer} against a real StateManager temp dir. The fold MUST
 * apply the identical transition logic the in-process loop uses:
 *   - DONE            → record producer_role + advance to the stage-after.
 *   - BLOCKED+escalate→ spec-defect drop (classify-before-retry: NO rung burned).
 *   - NEEDS_CONTEXT / unparseable → capability retry: bump the rung, clear reviewers,
 *     resume at the SAME producer stage — unless the ladder cap is reached, then a
 *     capability-budget drop.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordProducerCommand, applyRecordProducer } from "./record-producer.js";
import { EXIT } from "../exit-codes.js";
import { StateManager } from "../../core/state/manager.js";
import { ESCALATION_CAP } from "../../producer/index.js";
import type { TaskState } from "../../types/index.js";

const RUN_ID = "run-1";

async function seededState(
  task: Partial<TaskState> = {},
): Promise<{ dataDir: string; state: StateManager }> {
  const dataDir = await mkdtemp(join(tmpdir(), "factory-record-producer-"));
  const state = new StateManager({
    dataDir,
    lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
  });
  await state.create({
    run_id: RUN_ID,
    spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
  });
  await state.update(RUN_ID, (s) => ({
    ...s,
    tasks: {
      t1: {
        task_id: "t1",
        status: task.status ?? "executing",
        depends_on: [],
        risk_tier: "medium",
        escalation_rung: task.escalation_rung ?? 0,
        reviewers: task.reviewers ?? [],
      },
    },
  }));
  return { dataDir, state };
}

describe("record-producer arg/usage edges", () => {
  it("missing --run is a usage error", async () => {
    expect(
      await recordProducerCommand.run(["--task", "t1", "--stage", "exec", "--status", "DONE"]),
    ).toBe(EXIT.USAGE);
  });
  it("missing --stage is a usage error", async () => {
    expect(
      await recordProducerCommand.run(["--run", RUN_ID, "--task", "t1", "--status", "DONE"]),
    ).toBe(EXIT.USAGE);
  });
  it("missing --status is a usage error", async () => {
    expect(
      await recordProducerCommand.run(["--run", RUN_ID, "--task", "t1", "--stage", "exec"]),
    ).toBe(EXIT.USAGE);
  });
  it("a non-producer --stage (verify) is a usage error", async () => {
    expect(
      await recordProducerCommand.run([
        "--run",
        RUN_ID,
        "--task",
        "t1",
        "--stage",
        "verify",
        "--status",
        "DONE",
      ]),
    ).toBe(EXIT.USAGE);
  });
  it("--help prints help and exits OK", async () => {
    expect(await recordProducerCommand.run(["--help"])).toBe(EXIT.OK);
  });
});

describe("applyRecordProducer — DONE advances", () => {
  let dataDir: string;
  let state: StateManager;
  afterEach(async () => await rm(dataDir, { recursive: true, force: true }));

  it("tests/DONE records test-writer and advances to exec", async () => {
    ({ dataDir, state } = await seededState());
    const env = await applyRecordProducer(state, RUN_ID, "t1", "tests", "STATUS: DONE");

    expect(env.step).toEqual({ done: false, stage: "exec" });
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.producer_role).toBe("test-writer");
    expect(task.status).toBe("executing"); // markInFlight(exec)
  });

  it("exec/DONE records executor and advances to verify", async () => {
    ({ dataDir, state } = await seededState());
    const env = await applyRecordProducer(state, RUN_ID, "t1", "exec", "STATUS: DONE");

    expect(env.step).toEqual({ done: false, stage: "verify" });
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.producer_role).toBe("executor");
    expect(task.status).toBe("reviewing"); // markInFlight(verify)
  });
});

describe("applyRecordProducer — classify-before-retry (Δ D)", () => {
  let dataDir: string;
  let state: StateManager;
  afterEach(async () => await rm(dataDir, { recursive: true, force: true }));

  it("BLOCKED—escalate drops spec-defect immediately (no rung burned)", async () => {
    ({ dataDir, state } = await seededState({ escalation_rung: 0 }));
    const env = await applyRecordProducer(
      state,
      RUN_ID,
      "t1",
      "exec",
      "STATUS: BLOCKED — escalate",
    );

    expect(env.step.done).toBe(true);
    if (!env.step.done) throw new Error("unreachable");
    expect(env.step.outcome).toEqual(
      expect.objectContaining({ outcome: "dropped", failure_class: "spec-defect" }),
    );
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.status).toBe("dropped");
    expect(task.escalation_rung).toBe(0); // a drop never burns a rung
  });

  it("NEEDS_CONTEXT escalates a rung, clears reviewers, resumes at the same stage", async () => {
    ({ dataDir, state } = await seededState({
      escalation_rung: 0,
      reviewers: [{ reviewer: "quality", verdict: "approve", confirmed_blockers: 0 }],
    }));
    const env = await applyRecordProducer(state, RUN_ID, "t1", "exec", "STATUS: NEEDS_CONTEXT");

    expect(env.step).toEqual({ done: false, stage: "exec" });
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.escalation_rung).toBe(1);
    expect(task.reviewers).toEqual([]); // stale reviewers cleared on escalation
    expect(task.status).toBe("executing"); // cursor re-stamped at exec
  });

  it("an unparseable status is a capability retry (error → rung bump)", async () => {
    ({ dataDir, state } = await seededState({ escalation_rung: 0 }));
    const env = await applyRecordProducer(state, RUN_ID, "t1", "exec", "garbled nonsense");

    expect(env.step).toEqual({ done: false, stage: "exec" });
    expect((await state.read(RUN_ID)).tasks.t1!.escalation_rung).toBe(1);
  });

  it("an exhausted ladder drops capability-budget", async () => {
    ({ dataDir, state } = await seededState({ escalation_rung: ESCALATION_CAP }));
    const env = await applyRecordProducer(state, RUN_ID, "t1", "exec", "STATUS: NEEDS_CONTEXT");

    expect(env.step.done).toBe(true);
    if (!env.step.done) throw new Error("unreachable");
    expect(env.step.outcome).toEqual(
      expect.objectContaining({ outcome: "dropped", failure_class: "capability-budget" }),
    );
    expect((await state.read(RUN_ID)).tasks.t1!.status).toBe("dropped");
  });

  it("is LOUD on a missing task", async () => {
    ({ dataDir, state } = await seededState());
    await expect(
      applyRecordProducer(state, RUN_ID, "ghost", "exec", "STATUS: DONE"),
    ).rejects.toThrow(/no task 'ghost'/);
  });
});
