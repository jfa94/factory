import { describe, it, expect } from "vitest";
import { defaultConfig } from "../config/schema.js";
import { parseIso8601ToEpoch } from "../shared/time.js";
import { evaluate, type CircuitBreakerInput } from "./circuit-breaker.js";

const CONFIG = defaultConfig(); // maxConsecutiveFailures=3, maxRuntimeMinutes=480
const START = "2026-06-04T00:00:00Z";
const START_EPOCH = parseIso8601ToEpoch(START);

function input(over: Partial<CircuitBreakerInput> = {}): CircuitBreakerInput {
  return {
    startedAtIso: START,
    cumulativeFailures: 0,
    pausedMinutes: 0,
    ...over,
  };
}

describe("Circuit breaker — cumulative-failure trip", () => {
  it("does not trip below the cap", () => {
    expect(evaluate(input({ cumulativeFailures: 2 }), CONFIG, START_EPOCH)).toEqual({
      tripped: false,
    });
  });

  it("trips at the cap (>= maxConsecutiveFailures)", () => {
    const r = evaluate(input({ cumulativeFailures: 3 }), CONFIG, START_EPOCH);
    expect(r.tripped).toBe(true);
    if (r.tripped) expect(r.reason).toMatch(/cumulative failures/);
  });
});

describe("Circuit breaker — runtime trip with paused-minutes deduction", () => {
  it("trips when effective runtime reaches the cap", () => {
    // 480 wall minutes, 0 paused → tripped.
    const now = START_EPOCH + 480 * 60;
    const r = evaluate(input(), CONFIG, now);
    expect(r.tripped).toBe(true);
    if (r.tripped) expect(r.reason).toMatch(/max runtime/);
  });

  it("does NOT trip just under the runtime cap", () => {
    const now = START_EPOCH + 479 * 60;
    expect(evaluate(input(), CONFIG, now).tripped).toBe(false);
  });

  it("paused minutes are deducted (a quota pause never counts against runtime)", () => {
    // 500 wall minutes but 100 paused → effective 400 < 480 → not tripped.
    const now = START_EPOCH + 500 * 60;
    expect(evaluate(input({ pausedMinutes: 100 }), CONFIG, now).tripped).toBe(false);

    // Same wall time, only 19 paused → effective 481 >= 480 → tripped.
    expect(evaluate(input({ pausedMinutes: 19 }), CONFIG, now).tripped).toBe(true);
  });
});

describe("Circuit breaker — fail-closed on malformed inputs (treated as tripped)", () => {
  it("non-finite cumulativeFailures trips", () => {
    expect(evaluate(input({ cumulativeFailures: NaN }), CONFIG, START_EPOCH).tripped).toBe(true);
    expect(
      evaluate(input({ cumulativeFailures: Number.POSITIVE_INFINITY }), CONFIG, START_EPOCH)
        .tripped,
    ).toBe(true);
  });

  it("negative cumulativeFailures trips", () => {
    expect(evaluate(input({ cumulativeFailures: -1 }), CONFIG, START_EPOCH).tripped).toBe(true);
  });

  it("non-finite / negative pausedMinutes trips", () => {
    expect(evaluate(input({ pausedMinutes: NaN }), CONFIG, START_EPOCH).tripped).toBe(true);
    expect(evaluate(input({ pausedMinutes: -5 }), CONFIG, START_EPOCH).tripped).toBe(true);
  });

  it("unparseable startedAtIso trips", () => {
    const r = evaluate(input({ startedAtIso: "not-a-date" }), CONFIG, START_EPOCH);
    expect(r.tripped).toBe(true);
    if (r.tripped) expect(r.reason).toMatch(/unparseable/);
  });
});

describe("Circuit breaker — independent of quota", () => {
  it("a healthy run within both thresholds does not trip regardless of pause time", () => {
    // A pure quota pause (lots of paused minutes, no failures, short effective runtime)
    // must NOT trip the breaker.
    const now = START_EPOCH + 600 * 60;
    expect(
      evaluate(input({ cumulativeFailures: 0, pausedMinutes: 300 }), CONFIG, now).tripped,
    ).toBe(false);
  });
});
