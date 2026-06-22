import { describe, it, expect, vi, afterEach } from "vitest";
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

  // The both-or-neither guard. `file`/`line` are independently optional on the
  // schema (a half-citation is REPRESENTABLE, deliberately — finding.ts:12-17),
  // but isCitable is the SOLE gate both consumers run (panel-run / citation-verify)
  // and it must reject a half-citation exactly as it rejects a no-citation finding.
  // Pins that against a future refactor that loosens the conjunction (B3).
  it("isCitable is both-or-neither: a half-citation is NOT citable", () => {
    const fileOnly = parseFinding({
      reviewer: "security-reviewer",
      severity: "critical",
      blocking: true,
      file: "src/app.ts",
      quote: "const x = eval(input)",
      description: "file but no line",
    });
    expect(isCitable(fileOnly)).toBe(false);

    const lineOnly = parseFinding({
      reviewer: "security-reviewer",
      severity: "critical",
      blocking: true,
      line: 42,
      quote: "const x = eval(input)",
      description: "line but no file",
    });
    expect(isCitable(lineOnly)).toBe(false);
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
      reviewer: "security-reviewer",
      verdict: "blocked",
      findings: [
        {
          reviewer: "security-reviewer",
          severity: "critical",
          blocking: true,
          file: "src/app.ts",
          line: 10,
          quote: "eval(x)",
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
