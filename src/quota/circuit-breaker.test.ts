import { describe, it, expect } from "vitest";
import { defaultConfig } from "../config/schema.js";
import { evaluate, type CircuitBreakerInput } from "./circuit-breaker.js";

const CONFIG = defaultConfig(); // maxConsecutiveFailures=3

function input(over: Partial<CircuitBreakerInput> = {}): CircuitBreakerInput {
  return { cumulativeFailures: 0, ...over };
}

describe("Circuit breaker — cumulative-failure trip", () => {
  it("does not trip below the cap", () => {
    expect(evaluate(input({ cumulativeFailures: 2 }), CONFIG)).toEqual({
      tripped: false,
    });
  });

  it("trips at the cap (>= maxConsecutiveFailures)", () => {
    const r = evaluate(input({ cumulativeFailures: 3 }), CONFIG);
    expect(r.tripped).toBe(true);
    if (r.tripped) expect(r.reason).toMatch(/cumulative failures/);
  });
});

describe("Circuit breaker — the arm discriminator (severity mapping for the caller)", () => {
  it("labels each trip with its arm: failures / fail-closed", () => {
    const failures = evaluate(input({ cumulativeFailures: 3 }), CONFIG);
    expect(failures).toMatchObject({ tripped: true, arm: "failures" });

    const failClosed = evaluate(input({ cumulativeFailures: NaN }), CONFIG);
    expect(failClosed).toMatchObject({ tripped: true, arm: "fail-closed" });
  });
});

describe("Circuit breaker — fail-closed on malformed inputs (treated as tripped)", () => {
  it("non-finite cumulativeFailures trips", () => {
    expect(evaluate(input({ cumulativeFailures: NaN }), CONFIG).tripped).toBe(true);
    expect(evaluate(input({ cumulativeFailures: Number.POSITIVE_INFINITY }), CONFIG).tripped).toBe(
      true,
    );
  });

  it("negative cumulativeFailures trips", () => {
    expect(evaluate(input({ cumulativeFailures: -1 }), CONFIG).tripped).toBe(true);
  });
});
