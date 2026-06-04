import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseJson,
  JsonParseError,
  readJsonFileSync,
  writeJsonFileSync,
  writeJsonFile,
  readJsonFile,
  stringifyJson,
} from "./json.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "factory-json-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseJson", () => {
  it("parses valid JSON", () => {
    expect(parseJson<{ a: number }>('{"a":1}').a).toBe(1);
  });
  it("throws a typed JsonParseError with the source path on bad JSON", () => {
    try {
      parseJson("{not json", "/some/path.json");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(JsonParseError);
      expect((e as JsonParseError).path).toBe("/some/path.json");
    }
  });
});

describe("json file round-trip (atomic write)", () => {
  it("writeJsonFileSync then readJsonFileSync round-trips", () => {
    const p = join(dir, "x.json");
    const value = { nested: { arr: [1, 2, 3] }, s: "hi" };
    writeJsonFileSync(p, value);
    expect(readJsonFileSync(p)).toEqual(value);
  });

  it("async variant round-trips and leaves no temp residue", async () => {
    const p = join(dir, "y.json");
    await writeJsonFile(p, { ok: true });
    expect(await readJsonFile(p)).toEqual({ ok: true });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("stringifyJson is pretty with a trailing newline", () => {
    expect(stringifyJson({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});
