import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile, atomicWriteFileSync } from "./atomic-write.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "factory-atomic-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** No `.tmp` residue should remain in `dir`. */
function assertNoTempResidue() {
  const leftover = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
  expect(leftover).toEqual([]);
}

describe("atomicWriteFileSync", () => {
  it("round-trips content", () => {
    const target = join(dir, "a.json");
    atomicWriteFileSync(target, '{"hello":"world"}');
    expect(readFileSync(target, "utf8")).toBe('{"hello":"world"}');
    assertNoTempResidue();
  });

  it("creates parent directories", () => {
    const target = join(dir, "nested", "deep", "f.txt");
    atomicWriteFileSync(target, "x");
    expect(readFileSync(target, "utf8")).toBe("x");
  });

  it("atomically overwrites an existing file", () => {
    const target = join(dir, "b.txt");
    writeFileSync(target, "old");
    atomicWriteFileSync(target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
    assertNoTempResidue();
  });

  it("accepts binary (Uint8Array) data", () => {
    const target = join(dir, "bin");
    const data = new Uint8Array([0, 1, 2, 255]);
    atomicWriteFileSync(target, data);
    expect(new Uint8Array(readFileSync(target))).toEqual(data);
  });

  it("leaves no temp residue across many writes", () => {
    const target = join(dir, "c.txt");
    for (let i = 0; i < 25; i++) atomicWriteFileSync(target, `v${i}`);
    expect(readFileSync(target, "utf8")).toBe("v24");
    assertNoTempResidue();
  });
});

describe("atomicWriteFile (async)", () => {
  it("round-trips and overwrites with no residue", async () => {
    const target = join(dir, "d.txt");
    await atomicWriteFile(target, "first");
    await atomicWriteFile(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
    assertNoTempResidue();
  });
});
