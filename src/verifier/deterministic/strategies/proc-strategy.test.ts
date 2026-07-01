/**
 * WS6 — `procOutcome` failing-gate detail enrichment (D5 fix-forward).
 *
 * Root cause this guards: a failing process gate (lint/tsc/build) collapsed its
 * detail to a bare `"<label> exit=<code>"` — the concrete stderr/stdout (the only
 * place the actual lint/type error text lives) was discarded before it ever reached
 * `mergeGateBlockReason` / the fix-forward pipeline. A passing gate's detail is
 * UNCHANGED (no excerpt needed — there is nothing to fix).
 */
import { describe, expect, it } from "vitest";
import type { GateRan } from "../strategy.js";
import { proc } from "../fakes.js";
import { procOutcome } from "./proc-strategy.js";

describe("procOutcome", () => {
  it("a passing gate keeps the plain '<label> exit=0' detail (no excerpt appended)", () => {
    const out = procOutcome("lint", "eslint", proc(0, "", ""));
    expect(out.kind).toBe("ran");
    expect((out as GateRan).evidence.detail).toBe("eslint exit=0");
  });

  it("a failing gate appends a stderr excerpt to the detail (the T1 smoking gun)", () => {
    const out = procOutcome(
      "lint",
      "eslint",
      proc(1, "", "src/lib/x.ts\n  10:5  error  no-unsafe-assignment"),
    );
    expect(out.kind).toBe("ran");
    const detail = (out as GateRan).evidence.detail ?? "";
    expect(detail).toContain("eslint exit=1");
    expect(detail).toContain("no-unsafe-assignment");
  });

  it("falls back to stdout when stderr is empty", () => {
    const out = procOutcome("type", "tsc", proc(1, "src/a.ts(3,1): error TS2322", ""));
    const detail = (out as GateRan).evidence.detail ?? "";
    expect(detail).toContain("TS2322");
  });

  it("truncates an oversized excerpt (never blow up the prompt/state)", () => {
    const huge = "x".repeat(5000);
    const out = procOutcome("lint", "eslint", proc(1, "", huge));
    const detail = (out as GateRan).evidence.detail ?? "";
    expect(detail.length).toBeLessThan(1200);
    expect(detail).toContain("truncated");
  });
});
