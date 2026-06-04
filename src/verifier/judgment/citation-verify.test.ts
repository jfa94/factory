import { describe, it, expect } from "vitest";
import { REDACTION_TOKEN } from "../../shared/secret-patterns.js";
import { parseFinding, type Finding } from "./finding.js";
import { verifyCitations, type SourceReader } from "./citation-verify.js";

const SRC: Record<string, readonly string[]> = {
  "src/app.ts": [
    "import { x } from './x';", // line 1
    "function run(input: string) {", // 2
    "  const value = process(input);", // 3
    "  return value + 1;", // 4
    "}", // 5
  ],
};

const reader: SourceReader = {
  readLines: (file) => SRC[file] ?? null,
};

function f(partial: Partial<Finding> & Pick<Finding, "quote">): Finding {
  return parseFinding({
    reviewer: "quality-reviewer",
    severity: "error",
    blocking: true,
    file: "src/app.ts",
    line: 3,
    description: "concern",
    ...partial,
  });
}

describe("WS7 deterministic citation-verify (Δ K)", () => {
  it("Δ K: KEEPS a quote that substring-matches at the exact cited line", () => {
    const res = verifyCitations([f({ line: 3, quote: "const value = process(input)" })], reader);
    expect(res.kept.length).toBe(1);
    expect(res.dropped.length).toBe(0);
  });

  it("Δ K: KEEPS a quote off by ≤2 lines (the ±2 window)", () => {
    // quote is on line 5, cited at line 3 → within +2.
    const res = verifyCitations([f({ line: 3, quote: "}" })], reader);
    expect(res.kept.length).toBe(1);
    // cited at line 1, real quote on line 3 → within +2.
    const res2 = verifyCitations([f({ line: 1, quote: "const value = process(input)" })], reader);
    expect(res2.kept.length).toBe(1);
  });

  it("Δ K: DROPS a hallucinated quote absent from the ±2 window", () => {
    const res = verifyCitations(
      [
        f({ line: 1, quote: "const value = process(input)" }), // line 3, cited 1: +2 OK
        f({ line: 5, quote: "import { x } from './x';" }),
      ], // real on line 1, cited 5 → 4 away → DROP
      reader,
    );
    expect(res.kept.length).toBe(1);
    expect(res.dropped.length).toBe(1);
    expect(res.dropped[0]!.reason).toBe("quote-not-in-window");
  });

  it("Δ K: DROPS a quote pointing past EOF", () => {
    const res = verifyCitations([f({ line: 9999, quote: "anything" })], reader);
    expect(res.kept.length).toBe(0);
    expect(res.dropped[0]!.reason).toBe("line-out-of-range");
  });

  it("Δ K: DROPS a citation into a non-existent file", () => {
    const res = verifyCitations([f({ file: "src/missing.ts", line: 1, quote: "x" })], reader);
    expect(res.dropped[0]!.reason).toBe("file-not-found");
  });

  it("Δ K: DROPS an uncitable finding (no file:line)", () => {
    const finding = parseFinding({
      reviewer: "architecture-reviewer",
      severity: "warning",
      blocking: true,
      quote: "vague concern",
      description: "no location",
    });
    const res = verifyCitations([finding], reader);
    expect(res.dropped[0]!.reason).toBe("uncitable");
  });

  it("Δ K: is DETERMINISTIC — identical input yields identical kept/dropped", () => {
    const findings = [
      f({ line: 3, quote: "const value = process(input)" }),
      f({ line: 5, quote: "import { x } from './x';" }),
      f({ file: "src/missing.ts", line: 1, quote: "x" }),
    ];
    const a = verifyCitations(findings, reader);
    const b = verifyCitations(findings, reader);
    expect(a.kept.map((k) => k.quote)).toEqual(b.kept.map((k) => k.quote));
    expect(a.dropped.map((d) => d.reason)).toEqual(b.dropped.map((d) => d.reason));
  });

  it("Δ K (redaction): a secret in RETAINED finding text is redacted via secret-patterns", () => {
    const akia = "AKIA" + "IOSFODNN7EXAMPLE";
    const secretSrc: Record<string, readonly string[]> = {
      "src/leak.ts": [`const key = "${akia}";`],
    };
    const r: SourceReader = { readLines: (file) => secretSrc[file] ?? null };
    const finding = parseFinding({
      reviewer: "security-reviewer",
      severity: "critical",
      blocking: true,
      file: "src/leak.ts",
      line: 1,
      quote: `const key = "${akia}";`,
      description: `hardcoded key ${akia}`,
    });
    const res = verifyCitations([finding], r, { redact: true });
    expect(res.kept.length).toBe(1);
    expect(res.kept[0]!.quote).toContain(REDACTION_TOKEN);
    expect(res.kept[0]!.quote).not.toContain(akia);
    expect(res.kept[0]!.description).not.toContain(akia);
  });

  it("Δ K (redaction off): retained text is left verbatim when redact=false", () => {
    const akia = "AKIA" + "IOSFODNN7EXAMPLE";
    const secretSrc: Record<string, readonly string[]> = {
      "src/leak.ts": [`const key = "${akia}";`],
    };
    const r: SourceReader = { readLines: (file) => secretSrc[file] ?? null };
    const finding = parseFinding({
      reviewer: "security-reviewer",
      severity: "critical",
      blocking: true,
      file: "src/leak.ts",
      line: 1,
      quote: `const key = "${akia}";`,
      description: "hardcoded key",
    });
    const res = verifyCitations([finding], r, { redact: false });
    expect(res.kept[0]!.quote).toContain(akia);
  });
});
