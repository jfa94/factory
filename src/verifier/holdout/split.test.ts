/**
 * WS10 (holdout, Δ Y) — split determinism + count-clamp invariants.
 *
 * No fast-check in this repo (see panel.test.ts) — property-style coverage is a
 * deterministic loop over generated criteria sets + seeds.
 */
import { describe, expect, it } from "vitest";
import { holdoutCount, splitHoldout } from "./split.js";

describe("holdoutCount (floor + clamp to [1, total-1])", () => {
  it("withholds nothing when inactive", () => {
    expect(holdoutCount(1, 50)).toBe(0); // total ≤ 1
    expect(holdoutCount(5, 0)).toBe(0); // percent ≤ 0
    expect(holdoutCount(5, -10)).toBe(0);
    expect(holdoutCount(0, 20)).toBe(0);
  });

  it("floors total×percent/100", () => {
    expect(holdoutCount(10, 20)).toBe(2);
    expect(holdoutCount(5, 20)).toBe(1); // floor(1.0)
    expect(holdoutCount(7, 50)).toBe(3); // floor(3.5)
  });

  it("clamps up to 1 when the floor rounds to 0", () => {
    expect(holdoutCount(4, 20)).toBe(1); // floor(0.8) → 1
    expect(holdoutCount(3, 10)).toBe(1); // floor(0.3) → 1
  });

  it("clamps down to total-1 so ≥1 stays visible", () => {
    expect(holdoutCount(2, 100)).toBe(1);
    expect(holdoutCount(3, 100)).toBe(2);
    expect(holdoutCount(2, 90)).toBe(1);
  });
});

describe("splitHoldout", () => {
  const criteria = ["a", "b", "c", "d", "e"];

  it("returns all visible / none withheld when inactive", () => {
    expect(splitHoldout(criteria, 0, "task-1")).toEqual({ visible: criteria, withheld: [] });
    expect(splitHoldout(["solo"], 50, "task-1")).toEqual({ visible: ["solo"], withheld: [] });
  });

  it("is deterministic for the same (criteria, percent, seed)", () => {
    const a = splitHoldout(criteria, 40, "task-7");
    const b = splitHoldout(criteria, 40, "task-7");
    expect(a).toEqual(b);
  });

  it("withholds the configured count and partitions without loss or overlap", () => {
    const { visible, withheld } = splitHoldout(criteria, 40, "task-7");
    expect(withheld).toHaveLength(holdoutCount(5, 40)); // 2
    expect([...visible, ...withheld].sort()).toEqual([...criteria].sort());
    for (const c of withheld) expect(visible).not.toContain(c);
  });

  it("preserves original order within each sub-list", () => {
    const { visible, withheld } = splitHoldout(criteria, 40, "task-7");
    const idx = (c: string) => criteria.indexOf(c);
    for (let i = 1; i < visible.length; i++)
      expect(idx(visible[i]!)).toBeGreaterThan(idx(visible[i - 1]!));
    for (let i = 1; i < withheld.length; i++)
      expect(idx(withheld[i]!)).toBeGreaterThan(idx(withheld[i - 1]!));
  });

  it("varies the withheld SET by seed (the split is seed-keyed)", () => {
    // Over many seeds at least two distinct withheld sets appear (not a constant).
    const sets = new Set<string>();
    for (let s = 0; s < 40; s++)
      sets.add(splitHoldout(criteria, 40, `seed-${s}`).withheld.join("|"));
    expect(sets.size).toBeGreaterThan(1);
  });

  it("holds the partition invariants across generated sizes/percents/seeds", () => {
    for (let n = 1; n <= 12; n++) {
      const gen = Array.from({ length: n }, (_, i) => `crit-${i}`);
      for (const pct of [0, 5, 20, 33, 50, 80, 100]) {
        for (let s = 0; s < 5; s++) {
          const { visible, withheld } = splitHoldout(gen, pct, `t${n}-${pct}-${s}`);
          // Conservation: visible ∪ withheld == gen, disjoint.
          expect([...visible, ...withheld].sort()).toEqual([...gen].sort());
          expect(withheld).toHaveLength(holdoutCount(n, pct));
          // Never withhold everything when active.
          if (withheld.length > 0) expect(visible.length).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});
