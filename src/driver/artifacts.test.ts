/**
 * WS10 — prompt-artifact store: the `prompt_ref` round-trip both impls share,
 * absence is LOUD, run isolation, idempotent overwrite, plus the Fs-specific
 * on-disk path/shape (`runs/<run>/prompts/<task>/<label>.json`, valid JSON, the
 * returned ref is run-relative — not absolute). Mirrors holdout/store.test.ts.
 *
 * The Fs impl had no test before this (only InMemory was exercised via the loop);
 * this pins its atomic-write/read-back path so a regression there is caught here,
 * not at run time when a separate `factory run-task` process reads the artifact.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDir } from "../core/state/index.js";
import { buildProducerContext, type ProducerContext } from "../producer/index.js";
import { FsArtifactStore, InMemoryArtifactStore, type ArtifactStore } from "./artifacts.js";

/** A realistic, redaction-safe producer context (real builder, not a hand-rolled literal). */
function sampleContext(taskId = "task-1"): ProducerContext {
  return buildProducerContext({
    taskId,
    title: "add the widget",
    description: "wire the widget into the dashboard",
    visibleCriteria: ["renders", "is accessible"],
    files: ["src/widget.ts"],
    rung: 0,
  });
}

function contractFor(name: string, make: () => ArtifactStore) {
  describe(name, () => {
    it("round-trips a producer context by its prompt_ref", async () => {
      const store = make();
      const ctx = sampleContext();
      const ref = await store.putProducerContext("run-1", "task-1", "executor-r0", ctx);
      expect(ref).toBe("prompts/task-1/executor-r0.json");
      expect(await store.getProducerContext("run-1", ref)).toEqual(ctx);
    });

    it("is LOUD when the prompt_ref is absent", async () => {
      const store = make();
      await expect(
        store.getProducerContext("run-1", "prompts/task-1/ghost.json"),
      ).rejects.toThrow();
    });

    it("isolates by run id (same ref, different run → absent)", async () => {
      const store = make();
      const ref = await store.putProducerContext("run-A", "task-1", "executor-r0", sampleContext());
      await expect(store.getProducerContext("run-B", ref)).rejects.toThrow();
    });

    it("overwrites idempotently for the same (task, label) — a retried step is safe", async () => {
      const store = make();
      const first = sampleContext();
      await store.putProducerContext("run-1", "task-1", "executor-r0", first);
      const second = { ...sampleContext(), title: "RETRIED widget" };
      const ref = await store.putProducerContext("run-1", "task-1", "executor-r0", second);
      expect((await store.getProducerContext("run-1", ref)).title).toBe("RETRIED widget");
    });

    it("distinguishes labels so concurrent rungs/roles never collide", async () => {
      const store = make();
      const r0 = await store.putProducerContext("run-1", "task-1", "executor-r0", sampleContext());
      const r1 = await store.putProducerContext("run-1", "task-1", "executor-r1", {
        ...sampleContext(),
        rung: 1,
      });
      expect(r0).not.toBe(r1);
      expect((await store.getProducerContext("run-1", r0)).rung).toBe(0);
      expect((await store.getProducerContext("run-1", r1)).rung).toBe(1);
    });
  });
}

contractFor("InMemoryArtifactStore", () => new InMemoryArtifactStore());

describe("FsArtifactStore", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "artifact-store-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  contractFor("FsArtifactStore (contract)", () => new FsArtifactStore(dataDir));

  it("returns a RUN-RELATIVE prompt_ref (not an absolute path)", async () => {
    const store = new FsArtifactStore(dataDir);
    const ref = await store.putProducerContext("run-1", "task-1", "executor-r0", sampleContext());
    expect(isAbsolute(ref)).toBe(false);
    expect(ref).toBe("prompts/task-1/executor-r0.json");
  });

  it("persists valid JSON under runs/<run>/prompts/<task>/<label>.json", async () => {
    const store = new FsArtifactStore(dataDir);
    const ctx = sampleContext();
    const ref = await store.putProducerContext("run-1", "task-1", "executor-r0", ctx);
    const path = join(runDir(dataDir, "run-1"), ref);
    const onDisk = JSON.parse(await readFile(path, "utf8")) as ProducerContext;
    expect(onDisk).toEqual(ctx);
  });
});
