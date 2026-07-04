import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsCoverageStore } from "./coverage-store.js";
import type { CoverageSummary } from "./tools.js";

const SHA1 = "a".repeat(40);
const SHA256 = "b".repeat(64);
const SUMMARY: CoverageSummary = { lines: 90, branches: 80, functions: 70, statements: 85 };

describe("FsCoverageStore", () => {
  let root: string;
  let dir: string;
  let store: FsCoverageStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cov-store-"));
    dir = path.join(root, "coverage"); // does not exist yet — put must mkdir it
    store = new FsCoverageStore(dir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("misses with null on an unknown tree sha", async () => {
    expect(await store.get(SHA1)).toBeNull();
  });

  it("round-trips a summary (put creates the dir)", async () => {
    await store.put(SHA1, SUMMARY);
    expect(await store.get(SHA1)).toEqual(SUMMARY);
  });

  it("accepts 64-hex (sha256 repo) keys", async () => {
    await store.put(SHA256, SUMMARY);
    expect(await store.get(SHA256)).toEqual(SUMMARY);
  });

  it("throws LOUD on a corrupt entry (bad JSON) instead of silently re-measuring", async () => {
    await store.put(SHA1, SUMMARY);
    await writeFile(path.join(dir, `${SHA1}.json`), "not json", "utf8");
    await expect(store.get(SHA1)).rejects.toThrow(/corrupt entry/);
  });

  it("throws LOUD on an entry missing a metric", async () => {
    await store.put(SHA1, SUMMARY);
    await writeFile(path.join(dir, `${SHA1}.json`), JSON.stringify({ lines: 1 }), "utf8");
    await expect(store.get(SHA1)).rejects.toThrow(/corrupt entry/);
  });

  it.each(["../evil", "a".repeat(39), "A".repeat(40), "deadbeef", ""])(
    "refuses the non-sha key %j (path-traversal guard)",
    async (key) => {
      await expect(store.get(key)).rejects.toThrow(/invalid tree sha key/);
      await expect(store.put(key, SUMMARY)).rejects.toThrow(/invalid tree sha key/);
    },
  );

  it("leaves no tmp files behind after put", async () => {
    await store.put(SHA1, SUMMARY);
    await store.put(SHA256, SUMMARY);
    const files = await readdir(dir);
    expect(files.sort()).toEqual([`${SHA1}.json`, `${SHA256}.json`]);
  });
});
