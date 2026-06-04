import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readingFromCache,
  StatuslineUsageSignal,
  usageCachePath,
  fakeUsageSignal,
  STALE_CEILING_SECONDS,
  type UsageReading,
} from "./usage-source.js";

const NOW = 1_700_000_000; // fixed epoch seconds for determinism

/** A well-formed cache observed at `now`, both windows resetting in the future. */
function freshCache(over: { fivePct?: number; sevenPct?: number } = {}) {
  return {
    five_hour: {
      used_percentage: over.fivePct ?? 10,
      resets_at: NOW + 3600,
    },
    seven_day: {
      used_percentage: over.sevenPct ?? 5,
      resets_at: NOW + 86400,
    },
    captured_at: NOW,
  };
}

describe("Fail-closed usage source — readingFromCache (bash sentinel contract)", () => {
  it("maps a fresh, well-formed cache to an available reading with both windows", () => {
    const r = readingFromCache(freshCache({ fivePct: 42, sevenPct: 8 }), NOW);
    expect(r.kind).toBe("available");
    if (r.kind !== "available") throw new Error("unreachable");
    expect(r.fiveHour).toEqual({ utilizationPct: 42, resetsAtEpoch: NOW + 3600 });
    expect(r.sevenDay).toEqual({ utilizationPct: 8, resetsAtEpoch: NOW + 86400 });
    expect(r.capturedAt).toBe(NOW);
  });

  it("malformed (non-object) JSON → unavailable: usage-cache-malformed", () => {
    expect(readingFromCache("not-an-object", NOW)).toEqual({
      kind: "unavailable",
      reason: "usage-cache-malformed",
    });
    expect(readingFromCache(42, NOW).kind).toBe("unavailable");
  });

  it("missing five_hour / seven_day used_percentage → fields-missing", () => {
    const c = freshCache();
    delete (c.five_hour as { used_percentage?: number }).used_percentage;
    expect(readingFromCache(c, NOW)).toEqual({
      kind: "unavailable",
      reason: "usage-cache-fields-missing",
    });
  });

  it("non-numeric used_percentage → fields-missing (coerced, never crashes)", () => {
    const c = freshCache();
    (c.five_hour as { used_percentage: unknown }).used_percentage = "lots";
    expect(readingFromCache(c, NOW).kind).toBe("unavailable");
    expect((readingFromCache(c, NOW) as { reason: string }).reason).toBe(
      "usage-cache-fields-missing",
    );
  });

  it("missing / non-numeric resets_at → resets-at-missing (never synthesize a horizon)", () => {
    const c = freshCache();
    delete (c.seven_day as { resets_at?: number }).resets_at;
    expect((readingFromCache(c, NOW) as { reason: string }).reason).toBe("resets-at-missing");

    const c2 = freshCache();
    (c2.five_hour as { resets_at: unknown }).resets_at = null;
    expect((readingFromCache(c2, NOW) as { reason: string }).reason).toBe("resets-at-missing");
  });

  it("captured_at older than 3600s ceiling → too-stale (absence/staleness never opens the gate)", () => {
    const c = freshCache();
    c.captured_at = NOW - (STALE_CEILING_SECONDS + 1);
    expect((readingFromCache(c, NOW) as { reason: string }).reason).toBe("usage-cache-too-stale");
  });

  it("non-numeric captured_at coerces to 0 → too-stale (fail-closed on unknown age)", () => {
    const c = freshCache();
    (c as { captured_at: unknown }).captured_at = "never";
    expect((readingFromCache(c, NOW) as { reason: string }).reason).toBe("usage-cache-too-stale");
  });

  it("5h resets_at already in the past → five-hour-window-reset (post-reset stale guard)", () => {
    const c = freshCache();
    c.five_hour.resets_at = NOW; // <= now
    expect((readingFromCache(c, NOW) as { reason: string }).reason).toBe("five-hour-window-reset");
  });

  it("7d resets_at already in the past → seven-day-window-reset", () => {
    const c = freshCache();
    c.seven_day.resets_at = NOW - 10;
    expect((readingFromCache(c, NOW) as { reason: string }).reason).toBe("seven-day-window-reset");
  });
});

describe("Fail-closed usage source — StatuslineUsageSignal reads/maps the cache file", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "quota-usage-"));
    dirs.push(d);
    return d;
  }

  it("missing cache file → unavailable: usage-cache-missing (never throws)", async () => {
    const dataDir = tmp();
    const sig = new StatuslineUsageSignal({ dataDir, now: () => NOW });
    await expect(sig.read()).resolves.toEqual({
      kind: "unavailable",
      reason: "usage-cache-missing",
    });
  });

  it("malformed JSON on disk → unavailable: usage-cache-malformed (never throws)", async () => {
    const dataDir = tmp();
    writeFileSync(usageCachePath(dataDir), "{not json");
    const sig = new StatuslineUsageSignal({ dataDir, now: () => NOW });
    await expect(sig.read()).resolves.toEqual({
      kind: "unavailable",
      reason: "usage-cache-malformed",
    });
  });

  it("well-formed cache on disk → available reading", async () => {
    const dataDir = tmp();
    writeFileSync(usageCachePath(dataDir), JSON.stringify(freshCache({ fivePct: 30 })));
    const sig = new StatuslineUsageSignal({ dataDir, now: () => NOW });
    const r = await sig.read();
    expect(r.kind).toBe("available");
    if (r.kind === "available") expect(r.fiveHour.utilizationPct).toBe(30);
  });
});

describe("fakeUsageSignal — the unit-test seam", () => {
  it("returns the fixed reading it was given", async () => {
    const reading: UsageReading = { kind: "unavailable", reason: "resets-at-missing" };
    await expect(fakeUsageSignal(reading).read()).resolves.toEqual(reading);
  });
});
