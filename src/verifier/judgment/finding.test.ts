import { describe, it, expect } from "vitest";
import { parseFinding, parseRawReview, isCitable, type Finding } from "./finding.js";

const citable: unknown = {
  reviewer: "security-reviewer",
  severity: "critical",
  blocking: true,
  file: "src/app.ts",
  line: 42,
  quote: "const x = eval(input)",
  description: "eval on untrusted input",
};

describe("WS7 Finding schema (Δ K)", () => {
  it("Δ K: round-trips a well-formed citable finding", () => {
    const f = parseFinding(citable);
    expect(f.file).toBe("src/app.ts");
    expect(f.line).toBe(42);
    expect(isCitable(f)).toBe(true);
  });

  it("Δ K: a finding with NO file:line is parseable but uncitable (so citation-verify can drop it)", () => {
    const f = parseFinding({
      reviewer: "architecture-reviewer",
      severity: "warning",
      blocking: false,
      quote: "the module boundary leaks",
      description: "layering concern",
    });
    expect(isCitable(f)).toBe(false);
  });

  it("loud: rejects a missing quote", () => {
    expect(() =>
      parseFinding({
        reviewer: "r",
        severity: "error",
        blocking: true,
        file: "a.ts",
        line: 1,
        description: "no quote",
      }),
    ).toThrow();
  });

  it("loud: rejects an empty quote (unverifiable)", () => {
    expect(() => parseFinding({ ...(citable as object), quote: "" })).toThrow();
  });

  it("loud: rejects a bad severity (closed enum)", () => {
    expect(() => parseFinding({ ...(citable as object), severity: "nit" })).toThrow();
  });

  it("loud: rejects a non-positive line", () => {
    expect(() => parseFinding({ ...(citable as object), line: 0 })).toThrow();
  });

  it("loud: rejects a non-array findings on a RawReview", () => {
    expect(() => parseRawReview({ reviewer: "r", verdict: "blocked", findings: "oops" })).toThrow();
  });

  it("loud: rejects an unknown reviewer verdict", () => {
    expect(() => parseRawReview({ reviewer: "r", verdict: "maybe", findings: [] })).toThrow();
  });

  it("RawReview: accepts an approve with empty findings", () => {
    const r = parseRawReview({
      reviewer: "implementation-reviewer",
      verdict: "approve",
      findings: [],
    });
    expect(r.findings).toEqual([]);
  });

  it("isCitable narrows file+line to defined", () => {
    const f: Finding = parseFinding(citable);
    if (isCitable(f)) {
      // type-level: these are string/number, not optional. Runtime sanity:
      expect(typeof f.file).toBe("string");
      expect(typeof f.line).toBe("number");
    } else {
      throw new Error("expected citable");
    }
  });
});
