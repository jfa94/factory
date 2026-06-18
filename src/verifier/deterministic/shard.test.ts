/**
 * Cost-aware mutation sharding vectors. Pins the two invariants the CI workflow
 * depends on (output length === shard count; empty scope → empty shards) plus the
 * balance/determinism properties that make LPT strictly better than the retired
 * round-robin split.
 */
import { describe, expect, it } from "vitest";
import { shardByCost, sloc } from "./shard.js";

/** The retired round-robin split (`i % n`), kept here only as a balance baseline. */
function roundRobin(files: readonly string[], n: number): string[][] {
  const bins: string[][] = Array.from({ length: n }, () => []);
  files.forEach((f, i) => bins[i % n]!.push(f));
  return bins;
}

/** Makespan = the heaviest shard's total weight (the wall-clock long pole). */
function makespan(shards: string[], weightOf: (file: string) => number): number {
  return Math.max(
    ...shards.map((csv) => (csv === "" ? 0 : csv.split(",").reduce((s, f) => s + weightOf(f), 0))),
  );
}

describe("shardByCost — structural contracts (load-bearing for the CI matrix)", () => {
  it("returns exactly n shards regardless of file count", () => {
    expect(shardByCost([], [], 4)).toHaveLength(4);
    expect(shardByCost(["a.ts"], [10], 4)).toHaveLength(4);
    expect(shardByCost(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"], [1, 1, 1, 1, 1], 4)).toHaveLength(
      4,
    );
  });

  it("maps an empty scope to n empty strings", () => {
    expect(shardByCost([], [], 4)).toEqual(["", "", "", ""]);
  });

  it("partitions every file exactly once (no loss, no duplication)", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"];
    const out = shardByCost(files, [5, 4, 3, 2, 1, 1], 4);
    const placed = out.flatMap((csv) => (csv === "" ? [] : csv.split(",")));
    expect(placed.slice().sort()).toEqual(files.slice().sort());
    expect(placed).toHaveLength(files.length);
  });
});

describe("shardByCost — balance & determinism", () => {
  it("isolates a single dominant file and spreads the rest", () => {
    const files = ["heavy.ts", "a.ts", "b.ts", "c.ts"];
    const weights = [100, 1, 1, 1];
    const out = shardByCost(files, weights, 4);
    const heavyShard = out.find((csv) => csv.split(",").includes("heavy.ts"));
    expect(heavyShard).toBe("heavy.ts"); // alone in its shard
  });

  it("is deterministic — identical inputs yield identical assignments", () => {
    const files = ["src/x.ts", "src/y.ts", "src/z.ts", "src/w.ts"];
    const weights = [3, 3, 3, 3]; // all ties — tie-break must be stable
    expect(shardByCost(files, weights, 4)).toEqual(shardByCost(files, weights, 4));
  });

  it("breaks weight ties by path ascending (stable, order-independent)", () => {
    const asc = shardByCost(["a.ts", "b.ts"], [5, 5], 2);
    const desc = shardByCost(["b.ts", "a.ts"], [5, 5], 2);
    expect(asc).toEqual(desc);
  });

  it("beats round-robin makespan on a skewed distribution (the whole point)", () => {
    // `git diff` sorts heavy foundational modules early — the pathological case.
    const files = [
      "src/cli/a.ts",
      "src/cli/b.ts",
      "src/core/c.ts",
      "src/core/d.ts",
      "src/util/e.ts",
      "src/util/f.ts",
      "src/util/g.ts",
    ];
    const weight: Record<string, number> = {
      "src/cli/a.ts": 60,
      "src/cli/b.ts": 50,
      "src/core/c.ts": 40,
      "src/core/d.ts": 30,
      "src/util/e.ts": 5,
      "src/util/f.ts": 4,
      "src/util/g.ts": 3,
    };
    const weights = files.map((f) => weight[f]!);
    const lpt = makespan(shardByCost(files, weights, 4), (f) => weight[f]!);
    const rr = Math.max(
      ...roundRobin(files, 4).map((bin) => bin.reduce((s, f) => s + weight[f]!, 0)),
    );
    expect(lpt).toBeLessThanOrEqual(rr);
    // Concretely: LPT lands the optimal 60 long-pole; round-robin stacks 60+5=65.
    expect(lpt).toBe(60);
    expect(rr).toBeGreaterThan(lpt);
  });

  it("defaults missing / non-positive weights to 1", () => {
    const out = shardByCost(["a.ts", "b.ts"], [], 2);
    // Both weight-1 → one per shard.
    expect(out.filter((csv) => csv !== "")).toHaveLength(2);
  });
});

describe("sloc — weight proxy strips noise", () => {
  it("excludes blank, comment, and import/export-from lines", () => {
    const src = [
      "import { x } from './x';", // import
      "export { y } from './y';", // re-export
      "", // blank
      "// a line comment", // comment
      "/* one-line block */", // comment
      "/*", // block open
      " * jsdoc continuation", // comment
      " */", // block close
      "const a = 1;", // CODE
      "function f() {", // CODE
      "  return a;", // CODE
      "}", // CODE
    ].join("\n");
    expect(sloc(src)).toBe(4);
  });

  it("counts multi-line imports as a single skipped statement", () => {
    const src = ["import {", "  a,", "  b,", "} from './mod';", "const z = a + b;"].join("\n");
    expect(sloc(src)).toBe(1);
  });

  it("returns 0 for an empty or comment-only file", () => {
    expect(sloc("")).toBe(0);
    expect(sloc("// just\n// comments\n")).toBe(0);
  });
});
