import { describe, it, expect } from "vitest";
import { classifyFailure } from "./classify.js";

describe("classify-before-retry (Δ D) — deterministic/spec/environmental drop IMMEDIATELY", () => {
  it("spec-defect: a structurally-unfixable deterministic gate → IMMEDIATE drop (no rung burned)", () => {
    const d = classifyFailure({
      kind: "gate-failure",
      gate: "testability",
      structurallyUnfixable: true,
      reason: "criterion is untestable as written",
    });
    expect(d.action).toBe("drop");
    if (d.action === "drop") {
      expect(d.failureClass).toBe("spec-defect");
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });

  it("spec-defect: producer 'blocked-escalate' (STATUS: BLOCKED — escalate) → IMMEDIATE drop, no re-exec", () => {
    const d = classifyFailure({
      kind: "producer-status",
      status: "blocked-escalate",
      reason: "STATUS: BLOCKED — escalate: contradictory acceptance criteria",
    });
    expect(d.action).toBe("drop");
    if (d.action === "drop") expect(d.failureClass).toBe("spec-defect");
  });

  it("blocked-environmental: an environmental blocker → IMMEDIATE drop, no re-exec", () => {
    const d = classifyFailure({
      kind: "environmental",
      reason: "CI runner network unreachable",
    });
    expect(d.action).toBe("drop");
    if (d.action === "drop") expect(d.failureClass).toBe("blocked-environmental");
  });
});

describe("classify-before-retry (Δ D) — capability failures are RETRYABLE", () => {
  it("producer 'needs-context' → retry", () => {
    expect(
      classifyFailure({ kind: "producer-status", status: "needs-context", reason: "x" }).action,
    ).toBe("retry");
  });

  it("producer 'error' → retry", () => {
    expect(classifyFailure({ kind: "producer-status", status: "error", reason: "x" }).action).toBe(
      "retry",
    );
  });

  it("a fixable deterministic gate (failing tests/coverage/type/lint) → retry", () => {
    const d = classifyFailure({
      kind: "gate-failure",
      gate: "tests",
      structurallyUnfixable: false,
      reason: "2 tests failing",
    });
    expect(d.action).toBe("retry");
  });

  it("merge-gate-blocked (confirmed blockers remain) → retry (fix-forward)", () => {
    expect(classifyFailure({ kind: "merge-gate-blocked", reason: "blocked by security" }).action).toBe(
      "retry",
    );
  });

  it("verifier-error is LOUD but retryable (re-run verify) — never an auto-advance, never a silent drop (D27)", () => {
    const d = classifyFailure({ kind: "verifier-error", reason: "verifier crashed" });
    expect(d.action).toBe("retry");
    expect(d.reason).toContain("unresolved");
  });
});
