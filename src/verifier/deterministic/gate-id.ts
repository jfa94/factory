/**
 * WS6 — the closed gate-id vocabulary, as a LEAF module.
 *
 * Extracted from strategy.ts so both strategy.ts AND memo.ts can depend on the
 * gate-id type without forming a type-only import cycle (memo.ts ← strategy.ts
 * and strategy.ts → memo.ts previously tripped madge). This module imports
 * nothing — it is the bottom of the deterministic-verifier dependency graph.
 *
 * Adding a member is a deliberate compile-break across the runner's exhaustive
 * switch (strategyFor) — a new gate cannot be silently ignored.
 */

/** The closed set of deterministic gates. */
export type GateId = "test" | "tdd" | "coverage" | "mutation" | "sast" | "type" | "lint" | "build";

/** All gate ids, in canonical order (drives default enablement + iteration). */
export const GATE_IDS: readonly GateId[] = [
  "test",
  "tdd",
  "coverage",
  "mutation",
  "sast",
  "type",
  "lint",
  "build",
] as const;
