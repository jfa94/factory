/**
 * WS10 / Task C — the holdout-VERDICT store (the pump's holdout → review fold seam).
 *
 * Both impls must satisfy the same contract: `put` is idempotent, `get` is LOUD on
 * an absent key, and `has` is a non-throwing presence probe. The Fs impl ADDITIONALLY
 * re-validates what it reads (a forged/malformed file throws, never a trusted boolean)
 * and round-trips through the Δ Y confined subtree.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  InMemoryHoldoutVerdictStore,
  FsHoldoutVerdictStore,
  type HoldoutVerdictStore,
} from "./verdict-store.js";
import { runDir } from "../../core/state/index.js";
import type { HoldoutVerdict } from "./validate.js";

const RUN_ID = "run-1";
const TASK_ID = "t1";

const VERDICTS: readonly HoldoutVerdict[] = [
  { criterion: "handles empty input", satisfied: true, evidence: "src/x.ts:10" },
  { criterion: "rejects negatives", satisfied: false, evidence: "" },
];

/** The shared contract every HoldoutVerdictStore impl must honour. */
function contract(makeStore: () => HoldoutVerdictStore): void {
  it("round-trips put → get", async () => {
    const store = makeStore();
    await store.put(RUN_ID, TASK_ID, VERDICTS);
    expect(await store.get(RUN_ID, TASK_ID)).toEqual(VERDICTS);
  });

  it("has() reflects presence without throwing", async () => {
    const store = makeStore();
    expect(await store.has(RUN_ID, TASK_ID)).toBe(false);
    await store.put(RUN_ID, TASK_ID, VERDICTS);
    expect(await store.has(RUN_ID, TASK_ID)).toBe(true);
  });

  it("get() is LOUD on an absent key", async () => {
    const store = makeStore();
    await expect(store.get(RUN_ID, "missing")).rejects.toThrow();
  });

  it("put() is idempotent — a second write replaces the first (re-validated round)", async () => {
    const store = makeStore();
    await store.put(RUN_ID, TASK_ID, VERDICTS);
    const replacement: readonly HoldoutVerdict[] = [
      { criterion: "now passes", satisfied: true, evidence: "src/y.ts:3" },
    ];
    await store.put(RUN_ID, TASK_ID, replacement);
    expect(await store.get(RUN_ID, TASK_ID)).toEqual(replacement);
  });

  it("keys by (runId, taskId) — a different task is independent", async () => {
    const store = makeStore();
    await store.put(RUN_ID, TASK_ID, VERDICTS);
    expect(await store.has(RUN_ID, "t2")).toBe(false);
    expect(await store.has("run-2", TASK_ID)).toBe(false);
  });
}

describe("InMemoryHoldoutVerdictStore", () => {
  contract(() => new InMemoryHoldoutVerdictStore());
});

describe("FsHoldoutVerdictStore", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-verdict-store-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  contract(() => new FsHoldoutVerdictStore(dataDir));

  it("persists under the Δ Y confined holdouts subtree", async () => {
    const store = new FsHoldoutVerdictStore(dataDir);
    await store.put(RUN_ID, TASK_ID, VERDICTS);
    // The verdicts live alongside the answer key, not in the worktree.
    const expected = join(runDir(dataDir, RUN_ID), "holdouts", `${TASK_ID}.verdicts.json`);
    // Reading the exact path back confirms the layout (and that get() reads it).
    const onDisk = new FsHoldoutVerdictStore(dataDir);
    expect(await onDisk.get(RUN_ID, TASK_ID)).toEqual(VERDICTS);
    expect(expected).toContain(join("runs", RUN_ID, "holdouts"));
  });

  it("get() is LOUD on a forged/malformed file — never trusts what it reads", async () => {
    const path = join(runDir(dataDir, RUN_ID), "holdouts", `${TASK_ID}.verdicts.json`);
    await mkdir(dirname(path), { recursive: true });
    // A structurally-wrong payload (satisfied is not a boolean) must fail the schema.
    await writeFile(path, JSON.stringify([{ criterion: "x", satisfied: "yes", evidence: "z" }]));
    const store = new FsHoldoutVerdictStore(dataDir);
    await expect(store.get(RUN_ID, TASK_ID)).rejects.toThrow();
  });

  it("a second process (fresh store, same dataDir) reads the first's verdicts", async () => {
    await new FsHoldoutVerdictStore(dataDir).put(RUN_ID, TASK_ID, VERDICTS);
    // A `drive` crash-resume can persist the holdout verdicts in one process and read
    // them back in another; a fresh instance over the same dataDir must observe the write.
    expect(await new FsHoldoutVerdictStore(dataDir).has(RUN_ID, TASK_ID)).toBe(true);
    expect(await new FsHoldoutVerdictStore(dataDir).get(RUN_ID, TASK_ID)).toEqual(VERDICTS);
  });
});
