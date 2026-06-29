/**
 * WS6 — the closed gate-id vocabulary, as a LEAF module.
 *
 * Extracted from strategy.ts so both strategy.ts AND memo.ts can depend on the
 * gate-id type without forming a type-only import cycle (memo.ts ← strategy.ts
 * and strategy.ts → memo.ts previously tripped madge). GateId + EvidenceGate
 * are the source-of-truth in core/state/derive.ts (layer they belong to);
 * re-exported here so existing verifier/deterministic importers are unchanged.
 *
 * Adding a member is a deliberate compile-break across the runner's exhaustive
 * switch (strategyFor) — a new gate cannot be silently ignored.
 */

// Types live in core/state (sanctioned downward import); re-exported here for
// verifier/deterministic consumers so their import paths are unchanged.
import type { GateId } from "../../core/state/derive.js";
export type { GateId, EvidenceGate } from "../../core/state/derive.js";

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
