import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl, readJsonl } from "./jsonl.js";
import { JsonParseError } from "./json.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jsonl-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("appendJsonl", () => {
  it("creates parent dirs and appends one compact line per record", async () => {
    const path = join(dir, "nested", "deep", "log.jsonl");
    await appendJsonl(path, { a: 1 });
    await appendJsonl(path, { a: 2, s: "x" });

    const raw = await readFile(path, "utf8");
    expect(raw).toBe('{"a":1}\n{"a":2,"s":"x"}\n');
  });

  it("escapes embedded newlines so each record stays one line", async () => {
    const path = join(dir, "log.jsonl");
    await appendJsonl(path, { msg: "line1\nline2" });
    const records = await readJsonl<{ msg: string }>(path);
    expect(records).toEqual([{ msg: "line1\nline2" }]);
    const raw = await readFile(path, "utf8");
    expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
  });
});

describe("readJsonl", () => {
  it("round-trips appended records in order", async () => {
    const path = join(dir, "log.jsonl");
    await appendJsonl(path, { n: 1 });
    await appendJsonl(path, { n: 2 });
    await appendJsonl(path, { n: 3 });
    expect(await readJsonl<{ n: number }>(path)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("returns [] for a missing file (a run that emitted nothing)", async () => {
    expect(await readJsonl(join(dir, "absent.jsonl"))).toEqual([]);
  });

  it("skips blank lines", async () => {
    const path = join(dir, "log.jsonl");
    await writeFile(path, '{"a":1}\n\n  \n{"a":2}\n', "utf8");
    expect(await readJsonl<{ a: number }>(path)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("throws a JsonParseError naming the 1-based line on a torn/corrupt line", async () => {
    const path = join(dir, "log.jsonl");
    await writeFile(path, '{"a":1}\n{"a":2\n', "utf8"); // line 2 is torn
    await expect(readJsonl(path)).rejects.toThrowError(JsonParseError);
    await expect(readJsonl(path)).rejects.toThrow(/:2:/);
  });

  it("does not treat a directory-as-file mixup as empty", async () => {
    const path = join(dir, "asdir");
    await mkdir(path, { recursive: true });
    await expect(readJsonl(path)).rejects.toThrow();
  });
});
