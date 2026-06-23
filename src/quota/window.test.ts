import { describe, it, expect } from "vitest";
import {
  computeWindowHour,
  computeWindowDay,
  hourlyThresholdFor,
  dailyThresholdFor,
  FIVE_HOUR_WINDOW_SECONDS,
  SEVEN_DAY_WINDOW_SECONDS,
} from "./window.js";

const HOURLY = [20, 40, 60, 80, 90];
const DAILY = [20, 40, 60, 80, 95, 95, 95];

describe("D24 window math — computeWindowHour parity with bash compute_window_hour", () => {
  // window_start = resets - 18000; hour = floor((now - window_start)/3600)+1 clamped [1,5].
  const resets = 1_000_000; // arbitrary epoch (seconds)
  const windowStart = resets - FIVE_HOUR_WINDOW_SECONDS;

  it("just after reset → hour 1", () => {
    expect(computeWindowHour(resets, windowStart)).toBe(1);
    expect(computeWindowHour(resets, windowStart + 1)).toBe(1);
  });

  it("each hour boundary steps the window-hour", () => {
    expect(computeWindowHour(resets, windowStart + 3599)).toBe(1);
    expect(computeWindowHour(resets, windowStart + 3600)).toBe(2);
    expect(computeWindowHour(resets, windowStart + 2 * 3600)).toBe(3);
    expect(computeWindowHour(resets, windowStart + 3 * 3600)).toBe(4);
    expect(computeWindowHour(resets, windowStart + 4 * 3600)).toBe(5);
  });

  it("at/after reset clamps to hour 5", () => {
    expect(computeWindowHour(resets, resets)).toBe(5);
    expect(computeWindowHour(resets, resets + 99999)).toBe(5);
  });

  it("before window_start clamps to hour 1", () => {
    expect(computeWindowHour(resets, windowStart - 5000)).toBe(1);
  });
});

describe("D24 window math — computeWindowDay parity with bash compute_window_day", () => {
  const resets = 5_000_000;
  const windowStart = resets - SEVEN_DAY_WINDOW_SECONDS;

  it("just after reset → day 1", () => {
    expect(computeWindowDay(resets, windowStart)).toBe(1);
  });

  it("each day boundary steps the window-day", () => {
    for (let d = 0; d < 7; d++) {
      expect(computeWindowDay(resets, windowStart + d * 86400)).toBe(d + 1);
    }
  });

  it("at/after reset clamps to day 7; before start clamps to day 1", () => {
    expect(computeWindowDay(resets, resets)).toBe(7);
    expect(computeWindowDay(resets, resets + 999999)).toBe(7);
    expect(computeWindowDay(resets, windowStart - 100000)).toBe(1);
  });
});

describe("Window math — monotonic non-decreasing + in-range (deterministic property sweep)", () => {
  it("computeWindowHour is in [1,5] and non-decreasing as now advances", () => {
    const resets = 2_000_000;
    let prev = 0;
    for (let now = resets - FIVE_HOUR_WINDOW_SECONDS - 10000; now <= resets + 10000; now += 137) {
      const h = computeWindowHour(resets, now);
      expect(h).toBeGreaterThanOrEqual(1);
      expect(h).toBeLessThanOrEqual(5);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });

  it("computeWindowDay is in [1,7] and non-decreasing as now advances", () => {
    const resets = 9_000_000;
    let prev = 0;
    for (
      let now = resets - SEVEN_DAY_WINDOW_SECONDS - 100000;
      now <= resets + 100000;
      now += 4099
    ) {
      const d = computeWindowDay(resets, now);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(7);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
});

describe("D24 threshold curves — index by position with clamped bounds", () => {
  it("hourlyThresholdFor maps hours 1..5 to the frozen curve", () => {
    expect(HOURLY.map((_, i) => hourlyThresholdFor(i + 1, HOURLY))).toEqual(HOURLY);
  });

  it("dailyThresholdFor maps days 1..7 to the frozen curve", () => {
    expect(DAILY.map((_, i) => dailyThresholdFor(i + 1, DAILY))).toEqual(DAILY);
  });

  it("out-of-range positions clamp to the nearest curve endpoint", () => {
    expect(hourlyThresholdFor(0, HOURLY)).toBe(20);
    expect(hourlyThresholdFor(99, HOURLY)).toBe(90);
    expect(dailyThresholdFor(-3, DAILY)).toBe(20);
    expect(dailyThresholdFor(99, DAILY)).toBe(95);
  });

  it("an empty curve is a loud config defect, not a silent open gate", () => {
    expect(() => hourlyThresholdFor(1, [])).toThrow(/empty/);
  });
});
