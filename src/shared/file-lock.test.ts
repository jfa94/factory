import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, DEFAULT_FILE_LOCK_TUNING, type FileLockTuning } from "./file-lock.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "factory-filelock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Tight window so contended acquirers retry fast in the serialization test.
const TUNING: FileLockTuning = {
  ...DEFAULT_FILE_LOCK_TUNING,
  retries: 200,
  retryMinTimeout: 5,
  retryMaxTimeout: 20,
};

function opts(over: Partial<Parameters<typeof withFileLock>[0]> = {}) {
  return {
    dir,
    lockfile: join(dir, "x.lock"),
    label: "test",
    dirPolicy: "assert" as const,
    tuning: TUNING,
    ...over,
  };
}

describe("withFileLock", () => {
  it("returns fn's value and releases (a later acquire succeeds)", async () => {
    const v = await withFileLock(opts(), async () => 42);
    expect(v).toBe(42);
    // Lock released → re-acquire without contention.
    expect(await withFileLock(opts(), async () => "again")).toBe("again");
  });

  it("dirPolicy:'assert' throws when the parent dir is missing", async () => {
    const missing = join(dir, "nope");
    await expect(
      withFileLock(opts({ dir: missing, lockfile: join(missing, "x.lock") }), async () => 1),
    ).rejects.toThrow(/cannot lock test .*does not exist/);
  });

  it("dirPolicy:'create' mkdirs the parent dir", async () => {
    const fresh = join(dir, "made", "deep");
    expect(existsSync(fresh)).toBe(false);
    await withFileLock(
      opts({ dir: fresh, lockfile: join(fresh, "x.lock"), dirPolicy: "create" }),
      async () => undefined,
    );
    expect(existsSync(fresh)).toBe(true);
  });

  it("releases even when fn throws (next acquire succeeds)", async () => {
    await expect(
      withFileLock(opts(), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // If release had leaked, this would hang/retry-exhaust; it must succeed.
    expect(await withFileLock(opts(), async () => "ok")).toBe("ok");
  });

  it("serializes concurrent acquirers: no overlap, no lost updates", async () => {
    let active = false;
    let counter = 0;
    const N = 8;

    const run = () =>
      withFileLock(opts(), async () => {
        // If the lock didn't serialize, a second body would enter here first.
        expect(active).toBe(false);
        active = true;
        const seen = counter;
        await Promise.resolve(); // yield — interleaves without the lock
        counter = seen + 1;
        active = false;
      });

    await Promise.all(Array.from({ length: N }, run));
    expect(counter).toBe(N);
  });
});
