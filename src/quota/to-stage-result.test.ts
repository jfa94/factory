import { describe, it, expect } from "vitest";
import { decisionToStageResult } from "./to-stage-result.js";
import type { QuotaDecision } from "./pacer.js";

describe("D24 7d graceful stop — suspend-7d maps to gracefulStop('7d', reason, resets)", () => {
  it("produces a graceful-stop StageResult with scope 7d and the reset horizon", () => {
    const decision: QuotaDecision = {
      kind: "suspend-7d",
      resetsAtEpoch: 12345,
      reason: "7d quota over curve",
    };
    expect(decisionToStageResult(decision)).toEqual({
      kind: "graceful-stop",
      scope: "7d",
      reason: "7d quota over curve",
      resets_at_epoch: 12345,
    });
  });
});

describe("Δ E distinctness — quota can ONLY produce graceful-stop (never partial/drop)", () => {
  it("pause-5h → graceful-stop scope 5h with the 5h horizon", () => {
    const r = decisionToStageResult({
      kind: "pause-5h",
      resetsAtEpoch: 999,
      reason: "5h over",
    });
    expect(r).toEqual({
      kind: "graceful-stop",
      scope: "5h",
      reason: "5h over",
      resets_at_epoch: 999,
    });
  });

  it("proceed → null (no StageResult; the driver continues)", () => {
    expect(decisionToStageResult({ kind: "proceed" })).toBeNull();
  });

  it("unavailable-halt → graceful-stop 7d-shaped clean exit (no horizon known)", () => {
    const r = decisionToStageResult({ kind: "unavailable-halt", reason: "usage unavailable: x" });
    expect(r).toEqual({ kind: "graceful-stop", scope: "7d", reason: "usage unavailable: x" });
    // No resets_at_epoch when usage is unobservable.
    expect(r && "resets_at_epoch" in r).toBe(false);
  });

  it("every non-proceed decision yields kind 'graceful-stop' — never finalize/task terminal", () => {
    const decisions: QuotaDecision[] = [
      { kind: "pause-5h", resetsAtEpoch: 1, reason: "a" },
      { kind: "suspend-7d", resetsAtEpoch: 2, reason: "b" },
      { kind: "unavailable-halt", reason: "c" },
    ];
    for (const d of decisions) {
      const r = decisionToStageResult(d);
      expect(r).not.toBeNull();
      expect(r!.kind).toBe("graceful-stop");
      // Runtime proof the codomain excludes partial/drop.
      expect(["finalize-terminal", "task-terminal"]).not.toContain(r!.kind);
    }
  });
});
