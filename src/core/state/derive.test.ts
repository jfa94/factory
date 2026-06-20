import { describe, expect, it } from "vitest";
import {
  deriveGateVerdict,
  deriveAllGatesVerdict,
  derivePanelVerdict,
  deriveFloorVerdict,
  floorBlockReason,
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

describe("floorBlockReason — the single shared diagnostic for a blocked floor", () => {
  const blockedReviewer = (reviewer: string): ReviewerResult => ({
    reviewer,
    verdict: "blocked",
    confirmed_blockers: 1,
  });
  const erroredReviewer = (reviewer: string): ReviewerResult => ({
    reviewer,
    verdict: "error",
    confirmed_blockers: 0,
  });

  it("names a failing deterministic gate WITH its detail (not the generic fallback)", () => {
    const reason = floorBlockReason(
      [approve("impl")],
      [{ gate: "type", observed: false, detail: "tsc exit=1" }],
    );
    expect(reason).toContain("type");
    expect(reason).toContain("tsc exit=1");
    expect(reason).not.toBe("floor not unanimous");
  });

  it("names a failing gate without a detail by its id alone", () => {
    const reason = floorBlockReason([approve("impl")], [{ gate: "lint", observed: false }]);
    expect(reason).toContain("lint");
    expect(reason).not.toContain("(");
  });

  it("reports EMPTY gate evidence explicitly — the masking class the old fallback hid", () => {
    // deriveAllGatesVerdict fails an empty set, but with no failing-gate AND a
    // unanimous panel the old reason fell through to the generic string, hiding
    // that NO deterministic gate ran. The shared helper must name that cause.
    const reason = floorBlockReason([approve("impl")], []);
    expect(reason).toContain("no deterministic gate evidence");
    expect(reason).not.toBe("floor not unanimous");
  });

  it("names blocked and errored reviewers", () => {
    const reason = floorBlockReason(
      [blockedReviewer("security"), erroredReviewer("quality")],
      [{ gate: "tests", observed: true }],
    );
    expect(reason).toContain("blocked by: security");
    expect(reason).toContain("unresolved (verifier error): quality");
  });

  it("combines a failing gate AND a blocked reviewer in one reason", () => {
    const reason = floorBlockReason(
      [blockedReviewer("security")],
      [{ gate: "type", observed: false, detail: "tsc exit=1" }],
    );
    expect(reason).toContain("failed gates: type (tsc exit=1)");
    expect(reason).toContain("blocked by: security");
  });

  it("falls back to the generic reason only when nothing specific is identifiable", () => {
    // Gates present + observed; reviewers all approve — the only way control
    // reaches here in practice is a derivation the caller already deemed blocked.
    expect(floorBlockReason([approve("impl")], [{ gate: "tests", observed: true }])).toBe(
      "floor not unanimous",
    );
  });
});
