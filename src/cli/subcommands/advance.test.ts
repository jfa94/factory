/**
 * `factory advance` (C5) — the CURSOR writer.
 *
 * Two surfaces:
 *   1. arg/usage edges via {@link advanceCommand} (short-circuit before any wiring);
 *   2. the cursor transition via {@link applyAdvance} against a real StateManager
 *      temp dir — it stamps the in-flight status for the target stage + started_at,
 *      writes NO domain transition, and is LOUD on a missing task.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { advanceCommand, applyAdvance } from "./advance.js";
import { EXIT } from "../exit-codes.js";
import { StateManager } from "../../core/state/manager.js";

const RUN_ID = "run-1";

async function seededState(): Promise<{ dataDir: string; state: StateManager }> {
  const dataDir = await mkdtemp(join(tmpdir(), "factory-advance-"));
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
        status: "pending",
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

describe("advance arg/usage edges", () => {
  it("missing --run is a usage error", async () => {
    expect(await advanceCommand.run(["--task", "t1", "--to", "exec"])).toBe(EXIT.USAGE);
  });
  it("missing --task is a usage error", async () => {
    expect(await advanceCommand.run(["--run", RUN_ID, "--to", "exec"])).toBe(EXIT.USAGE);
  });
  it("missing --to is a usage error", async () => {
    expect(await advanceCommand.run(["--run", RUN_ID, "--task", "t1"])).toBe(EXIT.USAGE);
  });
  it("an unknown --to stage is a usage error", async () => {
    expect(await advanceCommand.run(["--run", RUN_ID, "--task", "t1", "--to", "bogus"])).toBe(
      EXIT.USAGE,
    );
  });
  it("--help prints help and exits OK", async () => {
    expect(await advanceCommand.run(["--help"])).toBe(EXIT.OK);
  });
});

describe("applyAdvance cursor transition", () => {
  let dataDir: string;
  let state: StateManager;

  beforeEach(async () => {
    ({ dataDir, state } = await seededState());
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("emits a non-terminal step at the target stage and stamps the in-flight status", async () => {
    const env = await applyAdvance(state, RUN_ID, "t1", "exec");

    expect(env).toEqual({ run_id: RUN_ID, task_id: "t1", step: { done: false, stage: "exec" } });
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.status).toBe("executing"); // stageToInFlightStatus(exec)
    expect(task.started_at).toBeDefined();
  });

  it("stamps started_at only on first entry (idempotent on re-advance)", async () => {
    await applyAdvance(state, RUN_ID, "t1", "tests");
    const first = (await state.read(RUN_ID)).tasks.t1!.started_at;
    await applyAdvance(state, RUN_ID, "t1", "exec");
    const second = (await state.read(RUN_ID)).tasks.t1!.started_at;
    expect(second).toBe(first);
  });

  it("maps verify → the reviewing status", async () => {
    await applyAdvance(state, RUN_ID, "t1", "verify");
    expect((await state.read(RUN_ID)).tasks.t1!.status).toBe("reviewing");
  });

  it("is LOUD on a missing task (never a silent create)", async () => {
    await expect(applyAdvance(state, RUN_ID, "ghost", "exec")).rejects.toThrow(/no task 'ghost'/);
  });
});
