import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "./manager.js";
import { runStatePath } from "./paths.js";
import { parseRunState, type SpecPointer } from "./schema.js";
import { atomicWriteFile } from "../../shared/atomic-write.js";
import { deriveFloorVerdict } from "./derive.js";

let dataDir: string;
const spec: SpecPointer = { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 };

function mgr(): StateManager {
  // Tight lock window so the concurrency test runs fast.
  return new StateManager({
    dataDir,
    lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "factory-state-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("lifecycle: create / read / update / finalize", () => {
  it("creates a run, writes state + logs + current symlink", async () => {
    const m = mgr();
    const run = await m.create({ run_id: "run-1", spec });
    expect(run.status).toBe("running");
    expect(existsSync(runStatePath(dataDir, "run-1"))).toBe(true);
    expect(existsSync(join(dataDir, "runs", "run-1", "audit.jsonl"))).toBe(true);
    expect(existsSync(join(dataDir, "runs", "run-1", "holdouts"))).toBe(true);

    const onDisk = parseRunState(
      JSON.parse(await readFile(runStatePath(dataDir, "run-1"), "utf8")),
    );
    expect(onDisk.run_id).toBe("run-1");
    expect(onDisk.spec).toEqual(spec);
  });

  it("refuses to clobber an existing run", async () => {
    const m = mgr();
    await m.create({ run_id: "run-1", spec });
    await expect(m.create({ run_id: "run-1", spec })).rejects.toThrow(/already exists/);
  });

  it("two concurrent same-id create() calls: exactly one wins, no silent clobber (TOCTOU)", async () => {
    const m = mgr();
    const specA: SpecPointer = { repo: "acme/a", spec_id: "1-a", issue_number: 1 };
    const specB: SpecPointer = { repo: "acme/b", spec_id: "2-b", issue_number: 2 };
    const settled = await Promise.allSettled([
      m.create({ run_id: "dup", spec: specA }),
      m.create({ run_id: "dup", spec: specB }),
    ]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(((rejected[0] as PromiseRejectedResult).reason as Error).message).toMatch(
      /already exists/,
    );

    // The on-disk state is the winner's, intact — not a last-writer-wins blend.
    const onDisk = await m.read("dup");
    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof m.create>>>)
      .value;
    expect(onDisk.spec).toEqual(winner.spec);
    expect([specA, specB]).toContainEqual(onDisk.spec);
  });

  it("readCurrent resolves the active run", async () => {
    const m = mgr();
    await m.create({ run_id: "run-1", spec });
    const cur = await m.readCurrent();
    expect(cur?.run_id).toBe("run-1");
  });

  it("update mutates under lock and re-stamps updated_at + re-validates", async () => {
    const m = mgr();
    await m.create({ run_id: "run-1", spec });
    const after = await m.update("run-1", (s) => ({
      ...s,
      tasks: {
        t1: {
          task_id: "t1",
          status: "pending",
          risk_tier: "low",
          escalation_rung: 0,
          depends_on: [],
          reviewers: [],
          merge_resyncs: 0,
        },
      },
    }));
    expect(after.tasks.t1?.task_id).toBe("t1");
  });

  it("a mutator that produces an out-of-enum value is rejected at write time", async () => {
    const m = mgr();
    await m.create({ run_id: "run-1", spec });
    await expect(
      m.update("run-1", (s) => ({ ...s, status: "interrupted" as never })),
    ).rejects.toThrow();
  });

  it("updateTask throws on an unknown task id (no silent create)", async () => {
    const m = mgr();
    await m.create({ run_id: "run-1", spec });
    await expect(m.updateTask("run-1", "ghost", (t) => t)).rejects.toThrow(/no task/);
  });

  it("update refuses a mutator that changes run identity (run_id / spec pointer)", async () => {
    const m = mgr();
    await m.create({ run_id: "run-1", spec });
    // run_id is immutable.
    await expect(m.update("run-1", (s) => ({ ...s, run_id: "run-2" }))).rejects.toThrow(/run_id/);
    // The spec pointer (repo / spec_id / issue_number) is immutable too.
    await expect(
      m.update("run-1", (s) => ({ ...s, spec: { ...s.spec, repo: "evil/other" } })),
    ).rejects.toThrow(/spec/);
    await expect(
      m.update("run-1", (s) => ({ ...s, spec: { ...s.spec, issue_number: 999 } })),
    ).rejects.toThrow(/spec/);
    // The original on-disk identity is untouched.
    const onDisk = await m.read("run-1");
    expect(onDisk.run_id).toBe("run-1");
    expect(onDisk.spec).toEqual(spec);
  });
});

describe("finalize is terminal, never spins (Decision 22/24)", () => {
  it("finalizes to a terminal status and stamps ended_at", async () => {
    const m = mgr();
    await m.create({ run_id: "run-1", spec });
    const done = await m.finalize("run-1", "completed");
    expect(done.status).toBe("completed");
    expect(done.ended_at).not.toBeNull();
  });

  it("refuses a non-terminal status for finalize", async () => {
    const m = mgr();
    await m.create({ run_id: "run-1", spec });
    await expect(m.finalize("run-1", "paused" as never)).rejects.toThrow(/terminal/);
    await expect(m.finalize("run-1", "running" as never)).rejects.toThrow(/terminal/);
  });

  it("refuses to re-finalize to a DIFFERENT terminal status", async () => {
    const m = mgr();
    await m.create({ run_id: "run-1", spec });
    await m.finalize("run-1", "completed");
    await expect(m.finalize("run-1", "partial")).rejects.toThrow(/already terminal/);
  });

  it("is idempotent for the same terminal status", async () => {
    const m = mgr();
    await m.create({ run_id: "run-1", spec });
    const a = await m.finalize("run-1", "partial");
    const b = await m.finalize("run-1", "partial");
    expect(b.status).toBe("partial");
    expect(b.ended_at).toBe(a.ended_at); // ended_at preserved, not bumped
  });
});

describe("derive-don't-store survives a forged on-disk verdict (Δ V, end-to-end)", () => {
  it("a forged gate boolean injected into state.json is stripped on read AND ignored by derivation", async () => {
    const m = mgr();
    await m.create({ run_id: "run-1", spec });
    await m.update("run-1", (s) => ({
      ...s,
      tasks: {
        t1: {
          task_id: "t1",
          status: "reviewing",
          risk_tier: "high",
          escalation_rung: 0,
          depends_on: [],
          merge_resyncs: 0,
          // Panel did NOT unanimously approve — security blocked.
          reviewers: [
            { reviewer: "impl", verdict: "approve", confirmed_blockers: 0 },
            { reviewer: "security", verdict: "blocked", confirmed_blockers: 1 },
          ],
        },
      },
    }));

    // Attacker bypasses the StateManager and forges a stored PASS directly on disk:
    // a `quality_gate: true` / `floor_passed: true` boolean meant to wave the task
    // through. This is exactly the TCB-write-gap the bash code was vulnerable to.
    const path = runStatePath(dataDir, "run-1");
    const onDisk = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const tasks = onDisk.tasks as Record<string, Record<string, unknown>>;
    const forged = tasks.t1!;
    forged.quality_gate = true;
    forged.floor_passed = true;
    forged.mutation_gate = true;
    await atomicWriteFile(path, JSON.stringify(onDisk));

    // 1) The schema strips the forged fields on read — they are structurally absent.
    const reread = await m.read("run-1");
    const t = reread.tasks.t1 as unknown as Record<string, unknown>;
    expect(t.quality_gate).toBeUndefined();
    expect(t.floor_passed).toBeUndefined();
    expect(t.mutation_gate).toBeUndefined();

    // 2) The floor verdict is re-derived from ground truth (the blocked panel +
    //    real gate evidence) and IGNORES the forgery — it FAILS, as it must.
    const verdict = deriveFloorVerdict(reread.tasks.t1!, [{ gate: "tests", observed: true }]);
    expect(verdict.passed).toBe(false);
    expect(verdict.__derived).toBe(true);
  });
});

describe("concurrency: ≥3 writers do not corrupt state", () => {
  // Correctness-critical (no lost updates) and load-sensitive (100 contended lock
  // acquisitions); 30s is harness headroom, not a behavior change.
  it("100 concurrent increments across 4 writers all land (no lost updates)", async () => {
    // Seed a numeric counter encoded in a task's escalation_rung.
    const m = mgr();
    await m.create({ run_id: "run-1", spec });
    await m.update("run-1", (s) => ({
      ...s,
      tasks: {
        c: {
          task_id: "c",
          status: "pending",
          risk_tier: "low",
          escalation_rung: 0,
          depends_on: [],
          reviewers: [],
          merge_resyncs: 0,
        },
      },
    }));

    const WRITERS = 4;
    const PER_WRITER = 25;

    await Promise.all(
      Array.from({ length: WRITERS }, () =>
        // sequentialize each writer's own bumps; writers race each other.
        (async () => {
          for (let i = 0; i < PER_WRITER; i++) {
            const wm = new StateManager({
              dataDir,
              lock: { stale: 5000, retries: 500, retryMinTimeout: 2, retryMaxTimeout: 40 },
            });
            await wm.updateTask("run-1", "c", (t) => ({
              ...t,
              escalation_rung: t.escalation_rung + 1,
            }));
          }
        })(),
      ),
    );

    const final = await m.read("run-1");
    expect(final.tasks.c?.escalation_rung).toBe(WRITERS * PER_WRITER);

    // And the file is still valid JSON parseable as a RunState (no torn write).
    const raw = await readFile(runStatePath(dataDir, "run-1"), "utf8");
    expect(() => parseRunState(JSON.parse(raw))).not.toThrow();
  }, 30_000);
});
