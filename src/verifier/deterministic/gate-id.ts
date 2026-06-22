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

/**
 * The closed evidence-label domain for {@link GateEvidence.gate}. A gate verdict's
 * evidence is produced by ONE of three sources, each with a structurally-closed
 * label: a deterministic gate ({@link GateId}), the holdout check (`"holdout"`),
 * or a panel reviewer (`` `panel:${reviewer}` ``). The template-literal member
 * captures the dynamic-but-closed panel labels in-place, so every construction
 * site type-checks while an arbitrary/typo'd label (e.g. `"tests"` — canonical is
 * `"test"`) is rejected at compile time. Widening this to `string` would re-open
 * the hole; keep it a closed union.
 */
export type EvidenceGate = GateId | "holdout" | `panel:${string}`;

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
