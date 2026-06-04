import { describe, expect, it } from "vitest";
import {
  deriveGateVerdict,
  deriveAllGatesVerdict,
  derivePanelVerdict,
  deriveFloorVerdict,
  type GateEvidence,
} from "./derive.js";
import type { ReviewerResult } from "./schema.js";

const approve = (reviewer: string): ReviewerResult => ({
  reviewer,
  verdict: "approve",
  confirmed_blockers: 0,
});

describe("derive-don't-store: verdicts are computed from ground truth (Δ V)", () => {
  it("a single gate verdict reflects the observed evidence", () => {
    const pass = deriveGateVerdict({ gate: "tests", observed: true });
    const fail = deriveGateVerdict({ gate: "tests", observed: false });
    expect(pass.passed).toBe(true);
    expect(fail.passed).toBe(false);
    // It is branded as derived and carries its evidence — never a bare boolean.
    expect(pass.__derived).toBe(true);
    expect(pass.from).toEqual([{ gate: "tests", observed: true }]);
  });

  it("flipping the evidence flips the verdict (re-derivation, not a cached read)", () => {
    const ev: GateEvidence = { gate: "mutation", observed: true };
    expect(deriveGateVerdict(ev).passed).toBe(true);
    ev.observed = false;
    expect(deriveGateVerdict(ev).passed).toBe(false);
  });

  it("an empty gate set FAILS — nothing-ran is never a pass", () => {
    expect(deriveAllGatesVerdict([]).passed).toBe(false);
  });

  it("the conjunction passes only when every gate passes", () => {
    expect(
      deriveAllGatesVerdict([
        { gate: "tests", observed: true },
        { gate: "coverage", observed: true },
      ]).passed,
    ).toBe(true);
    expect(
      deriveAllGatesVerdict([
        { gate: "tests", observed: true },
        { gate: "coverage", observed: false },
      ]).passed,
    ).toBe(false);
  });
});

describe("panel floor is conjunctive/unanimous (Decision 26)", () => {
  it("passes only on unanimous approve", () => {
    expect(derivePanelVerdict([approve("impl"), approve("security")]).passed).toBe(true);
  });

  it("a single blocked fails the floor", () => {
    expect(
      derivePanelVerdict([
        approve("impl"),
        { reviewer: "security", verdict: "blocked", confirmed_blockers: 1 },
      ]).passed,
    ).toBe(false);
  });

  it("an error reviewer is NOT silently treated as approve", () => {
    expect(
      derivePanelVerdict([
        approve("impl"),
        { reviewer: "type", verdict: "error", confirmed_blockers: 0 },
      ]).passed,
    ).toBe(false);
  });

  it("an empty panel fails (no reviewers = unverified)", () => {
    expect(derivePanelVerdict([]).passed).toBe(false);
  });

  it("accepts a TaskState-shaped object too", () => {
    expect(derivePanelVerdict({ reviewers: [approve("impl")] }).passed).toBe(true);
  });
});

describe("combined floor verdict requires BOTH layers", () => {
  const task = { reviewers: [approve("impl"), approve("security")] };

  it("passes when gates AND panel pass", () => {
    expect(deriveFloorVerdict(task, [{ gate: "tests", observed: true }]).passed).toBe(true);
  });

  it("fails when gates fail even if the panel approves", () => {
    expect(deriveFloorVerdict(task, [{ gate: "tests", observed: false }]).passed).toBe(false);
  });

  it("fails when the panel blocks even if gates pass", () => {
    const blocked = {
      reviewers: [{ reviewer: "x", verdict: "blocked" as const, confirmed_blockers: 1 }],
    };
    expect(deriveFloorVerdict(blocked, [{ gate: "tests", observed: true }]).passed).toBe(false);
  });

  it("fails with no gate evidence even if the panel approves", () => {
    expect(deriveFloorVerdict(task, []).passed).toBe(false);
  });
});
