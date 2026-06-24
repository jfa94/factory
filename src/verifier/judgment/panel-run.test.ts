import { describe, it, expect } from "vitest";
import {
  derivePanelVerdict,
  parseTaskState,
  type GateEvidence,
  type RiskTier,
} from "../../types/index.js";
import { parseRawReview, type RawReview } from "./finding.js";
import { type SourceReader } from "./citation-verify.js";
import { type FindingVerifierRunner, type VerifierVerdict } from "./finding-verifier.js";
import { runPanel } from "./panel-run.js";

const SRC: Record<string, readonly string[]> = {
  "src/app.ts": [
    "function run(input: string) {", // 1
    "  const value = process(input);", // 2
    "  return value;", // 3
    "}", // 4
  ],
};
const source: SourceReader = { readLines: (f) => SRC[f] ?? null };

// A passing deterministic gate so the merge gate's deterministic layer is satisfied;
// the panel layer is what these tests exercise.
const PASSING_GATES: readonly GateEvidence[] = [{ gate: "test", observed: true }];

function confirmAll(holds: boolean): (r: RawReview) => FindingVerifierRunner {
  return (review) => ({
    identity: `verifier-for-${review.reviewer}`,
    confirm: async (): Promise<VerifierVerdict> => ({ holds, note: "n" }),
  });
}

function approve(reviewer: string): RawReview {
  return parseRawReview({ reviewer, verdict: "approve", findings: [] });
}

function blockedWith(reviewer: string, line: number, quote: string): RawReview {
  return parseRawReview({
    reviewer,
    verdict: "blocked",
    findings: [
      {
        reviewer,
        severity: "critical",
        blocking: true,
        file: "src/app.ts",
        line,
        quote,
        description: "issue",
      },
    ],
  });
}

describe("WS7 panel-run integration (D26/D27, Δ K)", () => {
  it("D26 merge gate: unanimous approve → merge gate passes and advances to ship", async () => {
    const res = await runPanel({
      reviews: [approve("implementation-reviewer"), approve("quality-reviewer")],
      source,
      makeRunner: confirmAll(true),
      gateEvidence: PASSING_GATES,
      stage: "verify",
    });
    expect(res.mergeGate.passed).toBe(true);
    expect(res.result.kind).toBe("advance");
    if (res.result.kind === "advance") expect(res.result.to).toBe("ship");
  });

  it("D27: a confirmed blocker fails the merge gate → wait-retry, WS1 coherence holds (blocked⇒≥1)", async () => {
    const res = await runPanel({
      reviews: [
        approve("implementation-reviewer"),
        blockedWith("security-reviewer", 2, "const value = process(input)"),
      ],
      source,
      makeRunner: confirmAll(true),
      gateEvidence: PASSING_GATES,
      stage: "verify",
    });
    expect(res.mergeGate.passed).toBe(false);
    expect(res.result.kind).toBe("wait-retry");
    const sec = res.reviewerResults.find((r) => r.reviewer === "security-reviewer");
    expect(sec?.verdict).toBe("blocked");
    expect(sec?.confirmed_blockers).toBeGreaterThanOrEqual(1);
    // WS1 coherence: parseTaskState enforces approve⇒0 / blocked⇒≥1; the assembled
    // ReviewerResult[] must satisfy it.
    expect(() =>
      parseTaskState({
        task_id: "t1",
        status: "reviewing",
        risk_tier: "low" as RiskTier,
        reviewers: res.reviewerResults,
      }),
    ).not.toThrow();
  });

  it("Δ K: a hallucinated finding never reaches confirmation → merge gate passes", async () => {
    // Quote nowhere near the cited line (real text is on line 2, cited at 4 → 2 away
    // is OK; use a wholly absent quote instead).
    const res = await runPanel({
      reviews: [
        approve("implementation-reviewer"),
        blockedWith("security-reviewer", 1, "this code does not exist anywhere"),
      ],
      source,
      // If the dropped finding HAD reached confirmation, confirmAll(true) would
      // have confirmed it and failed the merge gate. It passes → it never got there.
      makeRunner: confirmAll(true),
      gateEvidence: PASSING_GATES,
      stage: "verify",
    });
    expect(res.mergeGate.passed).toBe(true);
    const sec = res.reviewerResults.find((r) => r.reviewer === "security-reviewer");
    expect(sec?.verdict).toBe("approve");
    expect(sec?.confirmed_blockers).toBe(0);
  });

  it("D27: a refuted blocker does not count → merge gate passes", async () => {
    const res = await runPanel({
      reviews: [blockedWith("security-reviewer", 2, "const value = process(input)")],
      source,
      makeRunner: confirmAll(false), // verifier refutes
      gateEvidence: PASSING_GATES,
      stage: "verify",
    });
    expect(res.mergeGate.passed).toBe(true);
  });

  it("D26 (loud error): an `error` reviewer fails the merge gate — never counted as approve", async () => {
    const errored = parseRawReview({
      reviewer: "quality-reviewer",
      verdict: "error",
      findings: [],
    });
    const res = await runPanel({
      reviews: [approve("implementation-reviewer"), errored],
      source,
      makeRunner: confirmAll(true),
      gateEvidence: PASSING_GATES,
      stage: "verify",
    });
    expect(res.mergeGate.passed).toBe(false);
    const q = res.reviewerResults.find((r) => r.reviewer === "quality-reviewer");
    expect(q?.verdict).toBe("error");
  });

  it("D27 (loud error): a verifier error on a blocker yields an `error` reviewer (unresolved, fails merge gate)", async () => {
    const res = await runPanel({
      reviews: [blockedWith("security-reviewer", 2, "const value = process(input)")],
      source,
      makeRunner: (review) => ({
        identity: `verifier-for-${review.reviewer}`,
        confirm: async () => {
          throw new Error("verifier crashed");
        },
      }),
      gateEvidence: PASSING_GATES,
      stage: "verify",
    });
    expect(res.mergeGate.passed).toBe(false);
    const sec = res.reviewerResults.find((r) => r.reviewer === "security-reviewer");
    expect(sec?.verdict).toBe("error");
  });

  it("Δ V: the merge gate is DERIVED from the reviewer results, never a stored boolean", async () => {
    const res = await runPanel({
      reviews: [approve("implementation-reviewer"), approve("quality-reviewer")],
      source,
      makeRunner: confirmAll(true),
      gateEvidence: PASSING_GATES,
      stage: "verify",
    });
    // Re-derive independently from the assembled results: must match runPanel's.
    const reDerived = derivePanelVerdict(res.reviewerResults);
    expect(reDerived.passed).toBe(true);
    expect(res.mergeGate.__derived).toBe(true);
  });

  it("D26: a failing deterministic gate fails the merge gate even with a unanimous panel", async () => {
    const res = await runPanel({
      reviews: [approve("implementation-reviewer")],
      source,
      makeRunner: confirmAll(true),
      gateEvidence: [{ gate: "test", observed: false }],
      stage: "verify",
    });
    expect(res.mergeGate.passed).toBe(false);
  });

  it("NAMES the failing deterministic gate in the wait-retry reason (not the generic 'merge gate not unanimous')", async () => {
    const res = await runPanel({
      reviews: [approve("implementation-reviewer")],
      source,
      makeRunner: confirmAll(true),
      gateEvidence: [{ gate: "type", observed: false, detail: "tsc exit=1" }],
      stage: "verify",
    });
    expect(res.mergeGate.passed).toBe(false);
    expect(res.result.kind).toBe("wait-retry");
    if (res.result.kind === "wait-retry") {
      // The masking bug returned "merge gate not unanimous" when a GATE (not a reviewer)
      // failed — hiding the real cause. The reason must name the gate + its detail.
      expect(res.result.reason).toContain("type");
      expect(res.result.reason).toContain("tsc exit=1");
      expect(res.result.reason).not.toBe("merge gate not unanimous");
    }
  });
});

describe("Δ U — cross-vendor ABSENCE reaches the panel result (WS8-wired)", () => {
  it("an `absent` cross-vendor resolution records PanelRunResult.crossVendorAbsence={reason} (LOUD, never silent)", async () => {
    const res = await runPanel({
      reviews: [approve("implementation-reviewer")],
      source,
      makeRunner: confirmAll(true),
      gateEvidence: PASSING_GATES,
      stage: "verify",
      crossVendor: { status: "absent", reason: "cross-vendor executor 'codex' is not available" },
    });
    expect(res.crossVendorAbsence).toBeDefined();
    expect(res.crossVendorAbsence?.reason).toContain("codex");
    // The absence must not silently change merge gate semantics.
    expect(res.mergeGate.passed).toBe(true);
  });

  it("a `present` cross-vendor resolution leaves crossVendorAbsence undefined", async () => {
    const res = await runPanel({
      reviews: [approve("implementation-reviewer")],
      source,
      makeRunner: confirmAll(true),
      gateEvidence: PASSING_GATES,
      stage: "verify",
      crossVendor: { status: "present", slot: { vendor: "codex", model: "gpt-x" } },
    });
    expect(res.crossVendorAbsence).toBeUndefined();
  });

  it("an OMITTED cross-vendor resolution leaves crossVendorAbsence undefined (back-compat, no behavior change)", async () => {
    const res = await runPanel({
      reviews: [approve("implementation-reviewer")],
      source,
      makeRunner: confirmAll(true),
      gateEvidence: PASSING_GATES,
      stage: "verify",
    });
    expect(res.crossVendorAbsence).toBeUndefined();
  });
});
