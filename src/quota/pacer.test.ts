import { describe, it, expect } from "vitest";
import { defaultConfig } from "../config/schema.js";
import { evaluate } from "./pacer.js";
import { FIVE_HOUR_WINDOW_SECONDS, SEVEN_DAY_WINDOW_SECONDS } from "./window.js";
import type { UsageReading } from "./usage-source.js";

const CONFIG = defaultConfig();
const HOURLY = CONFIG.quota.hourlyThresholds; // [20,40,60,80,90]
const DAILY = CONFIG.quota.dailyThresholds; // [14,29,43,57,71,86,95]

const NOW = 1_700_000_000;

/**
 * Build a reading whose 5h window sits at `hour` (1..5) with `fivePct` used, and
 * whose 7d window is comfortably under curve (so only the 5h dial moves).
 */
function readingAtHour(hour: number, fivePct: number): UsageReading {
  // Place now so computeWindowHour returns `hour`: now = window_start + (hour-1)*3600.
  const fiveResets = NOW + FIVE_HOUR_WINDOW_SECONDS - (hour - 1) * 3600;
  return {
    kind: "available",
    fiveHour: { utilizationPct: fivePct, resetsAtEpoch: fiveResets },
    sevenDay: { utilizationPct: 0, resetsAtEpoch: NOW + SEVEN_DAY_WINDOW_SECONDS },
    capturedAt: NOW,
  };
}

/** Build a reading whose 7d window sits at `day` (1..7) with `sevenPct` used. */
function readingAtDay(day: number, sevenPct: number, fivePct = 0): UsageReading {
  const sevenResets = NOW + SEVEN_DAY_WINDOW_SECONDS - (day - 1) * 86400;
  return {
    kind: "available",
    fiveHour: { utilizationPct: fivePct, resetsAtEpoch: NOW + FIVE_HOUR_WINDOW_SECONDS },
    sevenDay: { utilizationPct: sevenPct, resetsAtEpoch: sevenResets },
    capturedAt: NOW,
  };
}

describe("D24 5h pacing — simulated burn trips the right hourly checkpoint", () => {
  // For each window-hour, util strictly above the cap pauses; at/below proceeds.
  for (let hour = 1; hour <= 5; hour++) {
    const cap = HOURLY[hour - 1]!;
    it(`hour ${hour} (cap ${cap}%): ${cap + 1}% pauses, ${cap}% proceeds`, () => {
      const over = evaluate(readingAtHour(hour, cap + 1), CONFIG, NOW);
      expect(over.kind).toBe("pause-5h");
      if (over.kind === "pause-5h") {
        expect(over.reason).toMatch(/5h quota over curve/);
      }

      const atCap = evaluate(readingAtHour(hour, cap), CONFIG, NOW);
      expect(atCap.kind).toBe("proceed");
    });
  }

  it("the simulated-burn acceptance vector: 85% at window-hour 2 (cap 40) pauses", () => {
    const d = evaluate(readingAtHour(2, 85), CONFIG, NOW);
    expect(d.kind).toBe("pause-5h");
  });

  it("pause-5h carries the 5h reset horizon as resets_at_epoch", () => {
    const r = readingAtHour(3, 99);
    const d = evaluate(r, CONFIG, NOW);
    expect(d.kind).toBe("pause-5h");
    if (d.kind === "pause-5h" && r.kind === "available") {
      expect(d.resetsAtEpoch).toBe(r.fiveHour.resetsAtEpoch);
    }
  });
});

describe("D24 10% reserve floor — window-hour 5 cap is 90% (10% reserve)", () => {
  it("91% used at hour 5 pauses; 90% proceeds", () => {
    expect(evaluate(readingAtHour(5, 91), CONFIG, NOW).kind).toBe("pause-5h");
    expect(evaluate(readingAtHour(5, 90), CONFIG, NOW).kind).toBe("proceed");
  });
});

describe("D24 7d graceful stop — over the daily curve suspends (not pause, not partial)", () => {
  for (let day = 1; day <= 7; day++) {
    const cap = DAILY[day - 1]!;
    it(`day ${day} (cap ${cap}%): ${cap + 1}% suspends, ${cap}% proceeds`, () => {
      const over = evaluate(readingAtDay(day, cap + 1), CONFIG, NOW);
      expect(over.kind).toBe("suspend-7d");
      expect(evaluate(readingAtDay(day, cap), CONFIG, NOW).kind).toBe("proceed");
    });
  }

  it("suspend-7d carries the 7d reset horizon", () => {
    const r = readingAtDay(2, 99);
    const d = evaluate(r, CONFIG, NOW);
    expect(d.kind).toBe("suspend-7d");
    if (d.kind === "suspend-7d" && r.kind === "available") {
      expect(d.resetsAtEpoch).toBe(r.sevenDay.resetsAtEpoch);
    }
  });
});

describe("D24 binding-window rule — 7d dominates 5h when both breach", () => {
  it("both windows over curve → suspend-7d, never pause-5h", () => {
    // hour 1 cap 20, day 1 cap 14: push both over.
    const r: UsageReading = {
      kind: "available",
      fiveHour: { utilizationPct: 95, resetsAtEpoch: NOW + FIVE_HOUR_WINDOW_SECONDS },
      sevenDay: { utilizationPct: 95, resetsAtEpoch: NOW + SEVEN_DAY_WINDOW_SECONDS },
      capturedAt: NOW,
    };
    const d = evaluate(r, CONFIG, NOW);
    expect(d.kind).toBe("suspend-7d");
  });

  it("only 5h over → pause-5h (the non-dominant window still acts)", () => {
    expect(evaluate(readingAtHour(1, 50), CONFIG, NOW).kind).toBe("pause-5h");
  });
});

describe("Fail-closed pacer — unavailable reading maps to a clean halt, never proceed", () => {
  it("an unavailable reading → unavailable-halt with the reason threaded through", () => {
    const d = evaluate({ kind: "unavailable", reason: "resets-at-missing" }, CONFIG, NOW);
    expect(d.kind).toBe("unavailable-halt");
    if (d.kind === "unavailable-halt") expect(d.reason).toMatch(/resets-at-missing/);
  });
});
