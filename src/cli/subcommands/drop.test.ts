/**
 * `factory drop` (C5) — the explicit, classified LOUD drop (Δ D / Decision 22).
 *
 * arg/usage edges via {@link dropCommand}; the terminal transition via
 * {@link applyDrop} against a real StateManager temp dir — it persists the closed
 * failure class + reason and emits a terminal `dropped` step, and is LOUD on a
 * missing task or an out-of-enum class.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dropCommand, applyDrop } from "./drop.js";
import { EXIT } from "../exit-codes.js";
import { StateManager } from "../../core/state/manager.js";

const RUN_ID = "run-1";

async function seededState(): Promise<{ dataDir: string; state: StateManager }> {
  const dataDir = await mkdtemp(join(tmpdir(), "factory-drop-"));
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
        status: "executing",
        depends_on: [],
        risk_tier: "medium",
        escalation_rung: 0,
        reviewers: [],
        merge_resyncs: 0,
      },
    },
  }));
  return { dataDir, state };
}

describe("drop arg/usage edges", () => {
  it("missing --run is a usage error", async () => {
    expect(await dropCommand.run(["--task", "t1", "--class", "spec-defect", "--reason", "x"])).toBe(
      EXIT.USAGE,
    );
  });
  it("missing --class is a usage error", async () => {
    expect(await dropCommand.run(["--run", RUN_ID, "--task", "t1", "--reason", "x"])).toBe(
      EXIT.USAGE,
    );
  });
  it("missing --reason is a usage error", async () => {
    expect(await dropCommand.run(["--run", RUN_ID, "--task", "t1", "--class", "spec-defect"])).toBe(
      EXIT.USAGE,
    );
  });
  it("an unknown --class is a usage error", async () => {
    expect(
      await dropCommand.run(["--run", RUN_ID, "--task", "t1", "--class", "bogus", "--reason", "x"]),
    ).toBe(EXIT.USAGE);
  });
  it("--help prints help and exits OK", async () => {
    expect(await dropCommand.run(["--help"])).toBe(EXIT.OK);
  });
});

describe("applyDrop terminal transition", () => {
  let dataDir: string;
  let state: StateManager;

  beforeEach(async () => {
    ({ dataDir, state } = await seededState());
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("persists the classified drop and emits a terminal dropped step", async () => {
    const env = await applyDrop(state, RUN_ID, "t1", "spec-defect", "untestable criterion");

    expect(env).toEqual({
      run_id: RUN_ID,
      task_id: "t1",
      step: {
        done: true,
        outcome: {
          outcome: "dropped",
          failure_class: "spec-defect",
          reason: "untestable criterion",
        },
      },
    });
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.status).toBe("dropped");
    expect(task.failure_class).toBe("spec-defect");
    expect(task.failure_reason).toBe("untestable criterion");
    expect(task.ended_at).toBeDefined();
  });

  it("carries every closed failure class through to state", async () => {
    await applyDrop(state, RUN_ID, "t1", "blocked-environmental", "CI network down");
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.failure_class).toBe("blocked-environmental");
  });

  it("is LOUD on a missing task (never a silent drop)", async () => {
    await expect(applyDrop(state, RUN_ID, "ghost", "capability-budget", "x")).rejects.toThrow(
      /no task 'ghost'/,
    );
  });
});
