/**
 * WS1 — derive-don't-store gate-verdict accessors (Δ V / Decision 1 + 26).
 *
 * THE STRUCTURAL INVARIANT: a gate verdict is NEVER read back from `state.json`.
 * It is recomputed from GROUND TRUTH every time it is asked for. The bash code
 * stored `quality_gate.ok = true` and trusted it; a write-gap there meant a
 * forged PASS could merge bad code. Here there is no such field to forge (see
 * schema.ts — TaskState has no gate boolean), and these accessors are the only
 * way to obtain a verdict.
 *
 * How "structurally incapable of returning a stored boolean" is enforced:
 *   1. Every accessor takes its GROUND TRUTH as an argument (gate evidence, the
 *      panel reviewer-result array, …). It does NOT receive — and cannot reach —
 *      a persisted verdict field, because none exists.
 *   2. The return is a freshly-COMPUTED {@link GateVerdict}, tagged with the
 *      inputs it was derived from, so a caller can audit the derivation.
 *   3. The functions are pure: same inputs → same verdict, no I/O, no state read.
 *
 * Determinism-first (Decision 26): a deterministic gate's verdict is a function
 * of machine-checkable evidence; the panel (judgment) floor is the conjunction
 * (unanimity) over reviewer results — itself derived, never stored.
 */
import type { ReviewerResult, TaskState } from "./schema.js";

/**
 * Evidence a deterministic gate produced on this run/check. This is GROUND TRUTH
 * handed in by the gate runner (WS6) at gate time — never a value read back from
 * state. Kept minimal here (WS6 may pass a richer evidence type that structurally
 * extends this); the verdict derivation only needs the pass signal + an audit
 * trail of where it came from.
 */
export interface GateEvidence {
  /** Stable gate id, e.g. "tests" | "coverage" | "mutation" | "sast" | … */
  gate: string;
  /**
   * The raw machine-checkable outcome of running the gate NOW. The whole point of
   * derive-don't-store: this is produced by executing the gate, not by reading a
   * remembered boolean. If a caller could only supply a remembered value, that is
   * a bug in the caller — the type names this field `observed` to make that
   * misuse self-evident in review.
   */
  observed: boolean;
  /** Optional detail for the audit trail (e.g. "mutation score 82% ≥ 80%"). */
  detail?: string;
}

/**
 * A computed verdict. There is intentionally no constructor that takes a
 * pre-existing verdict — a `GateVerdict` can only come out of a `derive*`
 * function in this module, so it always carries its derivation.
 */
export interface GateVerdict {
  /** True iff the gate passes, computed from the supplied evidence. */
  readonly passed: boolean;
  /** The gate this verdict is for. */
  readonly gate: string;
  /** Brand: marks this value as freshly derived, not reconstructed from JSON. */
  readonly __derived: true;
  /** The evidence the verdict was derived from (audit trail). */
  readonly from: readonly GateEvidence[];
}

/**
 * Derive a single deterministic gate's verdict from its evidence. Pure.
 * Passes IFF `evidence.observed === true` — a false/absent observation FAILS,
 * never defaults open. (The "empty evidence SET fails" rule belongs to
 * {@link deriveAllGatesVerdict}, which guards the multi-gate case; this accessor
 * always receives exactly one piece of evidence.)
 */
export function deriveGateVerdict(evidence: GateEvidence): GateVerdict {
  return {
    passed: evidence.observed === true,
    gate: evidence.gate,
    __derived: true,
    from: [evidence],
  };
}

/**
 * Derive the conjunctive verdict over many gates: passes IFF every gate passes
 * AND at least one gate was supplied. An empty evidence set FAILS (a task with no
 * gates run has not been verified — never treat "nothing ran" as a pass).
 */
export function deriveAllGatesVerdict(evidence: readonly GateEvidence[]): GateVerdict {
  const passed = evidence.length > 0 && evidence.every((e) => e.observed === true);
  return {
    passed,
    gate: "all",
    __derived: true,
    from: [...evidence],
  };
}

/**
 * Derive the JUDGMENT-floor verdict (Decision 26/27): the panel is conjunctive
 * (unanimous `approve`). Derived from the reviewer-result array — which holds
 * each reviewer's opinion (ground truth of a judgment), not a stored floor
 * boolean. Passes IFF there is ≥1 reviewer AND every reviewer verdict is
 * `approve`. A single `blocked` or `error` fails the floor LOUDLY (an `error`
 * reviewer is never silently counted as approve).
 *
 * Takes the reviewer array (or a TaskState, from which it reads `reviewers`) and
 * NOTHING that could be a stored floor verdict.
 */
export function derivePanelVerdict(
  reviewersOrTask: readonly ReviewerResult[] | Pick<TaskState, "reviewers">,
): GateVerdict {
  // Array.isArray's guard is `any[]`, which does NOT narrow a readonly array out
  // of the union's else branch — so the Pick cast there is load-bearing, but the
  // true branch narrows cleanly without one.
  const reviewers: readonly ReviewerResult[] = Array.isArray(reviewersOrTask)
    ? reviewersOrTask
    : (reviewersOrTask as Pick<TaskState, "reviewers">).reviewers;
  const passed = reviewers.length > 0 && reviewers.every((r) => r.verdict === "approve");
  return {
    passed,
    gate: "panel",
    __derived: true,
    // The panel's "evidence" is each reviewer's verdict; expose it for audit.
    from: reviewers.map((r) => ({
      gate: `panel:${r.reviewer}`,
      observed: r.verdict === "approve",
      detail: `verdict=${r.verdict} confirmed_blockers=${r.confirmed_blockers}`,
    })),
  };
}

/**
 * The combined verifier-floor verdict for a task (Decision 26): BOTH the
 * deterministic gates AND the judgment panel must pass. Conjunctive across both
 * layers. Pure; derived entirely from the supplied evidence + the task's reviewer
 * array — never from a stored floor boolean.
 */
export function deriveFloorVerdict(
  task: Pick<TaskState, "reviewers">,
  gateEvidence: readonly GateEvidence[],
): GateVerdict {
  const det = deriveAllGatesVerdict(gateEvidence);
  const panel = derivePanelVerdict(task);
  return {
    passed: det.passed && panel.passed,
    gate: "floor",
    __derived: true,
    from: [...det.from, ...panel.from],
  };
}

/**
 * The human-facing reason a {@link deriveFloorVerdict} came back blocked — the
 * SINGLE source of truth shared by every live verify path (the fresh-review path
 * in `panel-run.ts` ← `runPanel`, and the resume / merge-resync re-entry path in
 * `handlers.ts`). Kept here, beside the floor derivation it explains, so the two
 * drivers cannot drift apart again (they previously held divergent copies — one
 * dropped the gate `detail`, one used different wording).
 *
 * Inspects BOTH halves of the floor (Decision 26):
 *   - Deterministic gates. An EMPTY evidence set is named EXPLICITLY ("no
 *     deterministic gate evidence"): `deriveAllGatesVerdict` fails an empty set
 *     ("nothing ran" is never a pass), yet an empty set surfaces no failing gate
 *     and — under a unanimous panel — no blocked/errored reviewer either, so the
 *     old reason fell through to the generic fallback and MASKED the real cause.
 *     A present-but-failing gate is named WITH its `detail` (e.g. `tsc exit=1`).
 *   - The reviewer panel. Blocked and errored reviewers are named.
 * Only when nothing specific is identifiable does the generic fallback remain.
 */
export function floorBlockReason(
  reviewers: readonly ReviewerResult[],
  gateEvidence: readonly GateEvidence[],
): string {
  const parts: string[] = [];
  if (gateEvidence.length === 0) {
    parts.push("no deterministic gate evidence");
  } else {
    const failed = gateEvidence.filter((g) => g.observed !== true);
    if (failed.length > 0) {
      const named = failed.map((g) => (g.detail ? `${g.gate} (${g.detail})` : g.gate));
      parts.push(`failed gates: ${named.join(", ")}`);
    }
  }
  const blocked = reviewers.filter((r) => r.verdict === "blocked").map((r) => r.reviewer);
  const errored = reviewers.filter((r) => r.verdict === "error").map((r) => r.reviewer);
  if (blocked.length > 0) parts.push(`blocked by: ${blocked.join(", ")}`);
  if (errored.length > 0) parts.push(`unresolved (verifier error): ${errored.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : "floor not unanimous";
}
