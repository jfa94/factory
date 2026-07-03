import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseFinding,
  parseRawReview,
  isCitable,
  MAX_FINDINGS_PER_REVIEW,
  type Finding,
} from "./finding.js";

const citable: unknown = {
  reviewer: "quality-reviewer",
  severity: "critical",
  blocking: true,
  file: "src/app.ts",
  line: 42,
  quote: "const x = eval(input)",
  claim: "eval() is called on unvalidated user input",
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
      reviewer: "quality-reviewer",
      severity: "warning",
      blocking: false,
      quote: "the module boundary leaks",
      claim: "the module boundary leaks",
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

  // S5/B1: `claim` is REQUIRED and bounded — the one-sentence checkable assertion
  // the finding-verifier confirms (anti-anchoring: distinct from `description`,
  // which carries the reviewer's reasoning chain and never reaches the verifier).
  // LOUD, no grace fallback: reviewer prompts + engine ship in one plugin bundle,
  // and findings are never persisted, so an old-format payload is a mid-upgrade
  // anomaly that must fail visibly, not degrade silently.
  it("loud: rejects a finding with NO claim (old-format payload)", () => {
    const { claim: _claim, ...withoutClaim } = citable as Record<string, unknown>;
    expect(() => parseFinding(withoutClaim)).toThrow();
  });

  it("loud: rejects an empty claim and a claim over 300 chars", () => {
    expect(() => parseFinding({ ...(citable as object), claim: "" })).toThrow();
    expect(() => parseFinding({ ...(citable as object), claim: "x".repeat(301) })).toThrow();
  });

  it("accepts a claim at exactly 300 chars", () => {
    const f = parseFinding({ ...(citable as object), claim: "x".repeat(300) });
    expect(f.claim).toHaveLength(300);
  });

  // T4: half-citations (file-without-line, line-without-file) are now a LOUD parse
  // error — rejected by FindingSchema's superRefine so reviewers get a ZodError
  // instead of a silent drop by isCitable (which was the old behavior).
  it("T4: parseFinding rejects half-citations (file-without-line, line-without-file)", () => {
    expect(() =>
      parseFinding({
        reviewer: "quality-reviewer",
        severity: "critical",
        blocking: true,
        file: "src/app.ts",
        quote: "const x = eval(input)",
        description: "file but no line",
      }),
    ).toThrow();

    expect(() =>
      parseFinding({
        reviewer: "quality-reviewer",
        severity: "critical",
        blocking: true,
        line: 42,
        quote: "const x = eval(input)",
        description: "line but no file",
      }),
    ).toThrow();
  });
});

describe("unknown-key stripping observability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parseRawReview: unknown top-level key parses successfully and logs a warn naming it", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = parseRawReview({
      reviewer: "quality-reviewer",
      verdict: "approve",
      findings: [],
      confidence: "high", // unknown key — should be stripped + warned
    });
    expect(r.findings).toEqual([]);
    expect(r).not.toHaveProperty("confidence");
    const output = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toMatch(/WARN/);
    expect(output).toMatch(/stripped unknown keys/);
    expect(output).toMatch(/confidence/);
  });

  it("parseRawReview: unknown key inside a finding parses successfully and logs a warn naming it", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = parseRawReview({
      reviewer: "quality-reviewer",
      verdict: "blocked",
      findings: [
        {
          reviewer: "quality-reviewer",
          severity: "critical",
          blocking: true,
          file: "src/app.ts",
          line: 10,
          quote: "eval(x)",
          claim: "eval is called on external input",
          description: "unsafe eval",
          rationale: "extra LLM key", // unknown — should be stripped + warned
        },
      ],
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).not.toHaveProperty("rationale");
    const output = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toMatch(/WARN/);
    expect(output).toMatch(/stripped unknown keys/);
    expect(output).toMatch(/rationale/);
  });

  it("parseRawReview: clean payload logs no warn", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    parseRawReview({
      reviewer: "implementation-reviewer",
      verdict: "approve",
      findings: [],
    });
    const output = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).not.toMatch(/stripped unknown keys/);
  });

  it("parseFinding: unknown key parses successfully and logs a warn naming it", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const f = parseFinding({
      ...(citable as object),
      extra_llm_field: "noise", // unknown — should be stripped + warned
    });
    expect(f).not.toHaveProperty("extra_llm_field");
    const output = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toMatch(/WARN/);
    expect(output).toMatch(/stripped unknown keys/);
    expect(output).toMatch(/extra_llm_field/);
  });
});

describe("findings cap + dropped_by_cap (D43)", () => {
  afterEach(() => vi.restoreAllMocks());

  const finding = (i: number) => ({
    reviewer: "quality-reviewer",
    severity: "warning",
    blocking: false,
    file: "src/app.ts",
    line: i + 1,
    quote: `const x${i} = 1`,
    claim: `claim ${i}`,
    description: `finding ${i}`,
  });
  const review = (count: number, extra?: Record<string, unknown>) => ({
    reviewer: "quality-reviewer",
    verdict: "blocked",
    findings: Array.from({ length: count }, (_, i) => finding(i)),
    ...extra,
  });

  it("a review over the cap is truncated to the FIRST 10 with the overflow in dropped_by_cap + a warn", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = parseRawReview(review(12));
    expect(r.findings).toHaveLength(MAX_FINDINGS_PER_REVIEW);
    // Head kept (the reviewer's own likelihood × impact ranking), tail dropped.
    expect(r.findings[0]!.description).toBe("finding 0");
    expect(r.findings[9]!.description).toBe("finding 9");
    expect(r.dropped_by_cap).toBe(2);
    const output = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toMatch(/exceeded the findings cap/);
  });

  it("engine truncation stacks on top of a self-reported dropped_by_cap", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = parseRawReview(review(11, { dropped_by_cap: 3 }));
    expect(r.findings).toHaveLength(10);
    expect(r.dropped_by_cap).toBe(4);
  });

  it("a self-reported dropped_by_cap survives parsing (not stripped) and warns for visibility", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = parseRawReview(review(2, { dropped_by_cap: 5 }));
    expect(r.dropped_by_cap).toBe(5);
    const output = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).not.toMatch(/stripped unknown keys/);
    expect(output).toMatch(/dropped 5 finding\(s\) by cap/);
  });

  it("a review at or under the cap passes through untruncated with no cap warn", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = parseRawReview(review(10));
    expect(r.findings).toHaveLength(10);
    expect(r.dropped_by_cap).toBeUndefined();
    const output = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(output).not.toMatch(/findings cap/);
  });

  it("loud: rejects a negative or non-integer dropped_by_cap", () => {
    expect(() => parseRawReview(review(1, { dropped_by_cap: -1 }))).toThrow();
    expect(() => parseRawReview(review(1, { dropped_by_cap: 1.5 }))).toThrow();
  });
});
