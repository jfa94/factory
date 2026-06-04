/**
 * WS8 — the FIX-FORWARD inner loop (Decision 27).
 *
 * The verifier (WS7 runPanel) returns CONFIRMED blockers (post citation-verify +
 * independent confirmation). The producer's inner-loop job is to PATCH forward —
 * route the task back to the EXECUTOR to fix the specific confirmed misses, NOT
 * to nuke-and-restart (the nuke is the OUTER ladder, ladder.ts). Before patching,
 * the producer may REBUT a confirmed finding EXACTLY ONCE — adjudicated
 * independently by WS7 (adjudicateRebuttal + RebuttalLedger). WS7 already enforces
 * single-shot + independence STRUCTURALLY (it throws on a second rebuttal of the
 * same finding or on an adjudicator identity equal to the original reviewer); WS8
 * MUST NOT re-implement that adjudication — it only DRIVES it and surfaces the
 * outcome.
 *
 * LOUD: a verifier ERROR (PanelRunResult.hadVerifierError, surfaced here via
 * {@link FixForwardInput.hadVerifierError}) is UNRESOLVED — it never auto-ships
 * and never silently passes; {@link runFixForward} returns `verifier-error` so the
 * ladder blocks (wait-retry / classified drop), never advances.
 */
import type { Finding } from "../verifier/judgment/finding.js";
import {
  adjudicateRebuttal,
  RebuttalLedger,
  type ProducerRebuttal,
  type RebuttalAdjudicator,
} from "../verifier/judgment/rebuttal.js";

/**
 * A single producer rebuttal request, paired with the finding it rebuts and the
 * identity of the reviewer that raised it (so WS7 can assert independence).
 */
export interface RebuttalRequest {
  /** The confirmed finding being rebutted. */
  readonly finding: Finding;
  /** The producer's counter-evidence. */
  readonly rebuttal: ProducerRebuttal;
  /** The reviewer that raised the finding (WS7 forbids them adjudicating it). */
  readonly originalReviewer: string;
}

/** Inputs to one fix-forward pass. */
export interface FixForwardInput {
  /** The confirmed blockers from the verify pass (PanelRunResult.confirmedBlockers). */
  readonly confirmedBlockers: readonly Finding[];
  /**
   * Whether the verify pass had an UNRESOLVED verifier error
   * (PanelRunResult.hadVerifierError). When true, the floor is LOUDLY unresolved
   * and fix-forward refuses to treat the run as shippable — it returns
   * `verifier-error` regardless of the blocker count.
   */
  readonly hadVerifierError: boolean;
  /**
   * The ONE producer rebuttal to drive this pass (optional). WS7 enforces
   * exactly-once via the supplied {@link RebuttalLedger}; supplying a second
   * rebuttal of the same finding makes adjudicateRebuttal THROW — WS8 surfaces it
   * loudly, it does not catch-and-swallow.
   */
  readonly rebuttal?: RebuttalRequest;
  /** The independent adjudicator (WS7) — must NOT be the original reviewer. */
  readonly adjudicator?: RebuttalAdjudicator;
  /**
   * The rebuttal ledger that enforces single-shot across passes. Supplied by the
   * caller (the ladder) so it persists across fix-forward iterations.
   */
  readonly ledger?: RebuttalLedger;
}

/**
 * The outcome of one fix-forward pass. CLOSED discriminated union:
 *   - `verifier-error`     — the verify pass was unresolved (LOUD); the floor
 *     cannot be cleared. Never ship past it.
 *   - `rebutted-overturned`— the producer's one rebuttal was UPHELD by the
 *     independent adjudicator (the finding is OVERTURNED); the remaining blockers
 *     (if any) still need a patch.
 *   - `patch-required`     — there are confirmed blockers (after any rebuttal)
 *     the executor must PATCH; carries the remaining findings.
 *   - `clear`              — no confirmed blockers remain and no verifier error;
 *     the floor is clear for this pass (the ladder re-derives via runPanel).
 */
export type FixForwardResult =
  | { readonly status: "verifier-error" }
  | {
      readonly status: "rebutted-overturned";
      readonly note: string;
      readonly remaining: readonly Finding[];
    }
  | { readonly status: "patch-required"; readonly remaining: readonly Finding[] }
  | { readonly status: "clear" };

/**
 * Run ONE fix-forward pass over a verify result (D27). PURE-ish (only awaits the
 * injected adjudicator). Does NOT spawn the executor itself — it RETURNS the
 * remaining blockers the ladder feeds into the executor's PATCH spawn via
 * prompt-context.ts. This keeps the inner loop testable without an agent.
 *
 * Order of operations:
 *   1. A verifier error short-circuits to `verifier-error` (LOUD; never shipped).
 *   2. If a rebuttal is supplied, drive it ONCE via WS7 (which enforces
 *      single-shot + independence). An OVERTURNED finding is removed from the
 *      remaining set; an UPHELD one stays.
 *   3. The remaining confirmed blockers decide the result: none ⇒ `clear`;
 *      some ⇒ `patch-required` (or `rebutted-overturned` if a rebuttal just
 *      overturned one but others remain).
 */
export async function runFixForward(input: FixForwardInput): Promise<FixForwardResult> {
  // (1) LOUD verifier error: unresolved, never shippable.
  if (input.hadVerifierError) {
    return { status: "verifier-error" };
  }

  let remaining: readonly Finding[] = input.confirmedBlockers;
  let overturnedNote: string | undefined;

  // (2) Drive the ONE producer rebuttal, if any. WS7 enforces single-shot +
  // independence; WS8 only drives + surfaces. A second rebuttal of the same
  // finding (or a non-independent adjudicator) THROWS out of adjudicateRebuttal —
  // we do NOT swallow it; that is the intended loud failure.
  if (input.rebuttal !== undefined) {
    if (input.adjudicator === undefined || input.ledger === undefined) {
      throw new Error(
        "runFixForward: a rebuttal was supplied without an adjudicator and ledger (WS7 drives the adjudication)",
      );
    }
    const outcome = await adjudicateRebuttal(
      input.rebuttal.finding,
      input.rebuttal.rebuttal,
      input.adjudicator,
      input.rebuttal.originalReviewer,
      input.ledger,
    );
    if (outcome.status === "overturned") {
      overturnedNote = outcome.note;
      const target = input.rebuttal.finding;
      remaining = remaining.filter((f) => !sameFinding(f, target));
    }
    // `upheld` ⇒ the finding stays in `remaining` (the producer must patch it).
  }

  // (3) Decide from the remaining confirmed blockers.
  if (remaining.length === 0) {
    return overturnedNote !== undefined
      ? { status: "rebutted-overturned", note: overturnedNote, remaining: [] }
      : { status: "clear" };
  }

  return overturnedNote !== undefined
    ? { status: "rebutted-overturned", note: overturnedNote, remaining }
    : { status: "patch-required", remaining };
}

/**
 * Stable identity for a finding (mirrors the RebuttalLedger key shape: WS7 keys on
 * file:line:reviewer:quote). Used to remove an overturned finding from the
 * remaining set.
 */
function sameFinding(a: Finding, b: Finding): boolean {
  return (
    (a.file ?? "?") === (b.file ?? "?") &&
    (a.line ?? -1) === (b.line ?? -1) &&
    a.reviewer === b.reviewer &&
    a.quote === b.quote
  );
}
