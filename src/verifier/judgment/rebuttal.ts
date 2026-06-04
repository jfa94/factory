/**
 * WS7 — producer rebuttal adjudication (Decision 27, rebuttal clause).
 *
 * After a finding is independently CONFIRMED (finding-verifier.ts), the PRODUCER
 * gets EXACTLY ONE chance to rebut it with evidence. The rebuttal is adjudicated
 * by the INDEPENDENT finding-verifier — NOT by the original reviewer who raised
 * the finding (the reviewer would just defend its own claim). Single shot: there
 * is no multi-round debate; a second rebuttal is refused.
 *
 * {@link adjudicateRebuttal} runs the verifier's adjudication EXACTLY ONCE and
 * returns whether the confirmed blocker is UPHELD or OVERTURNED. A
 * {@link RebuttalLedger} enforces the "exactly once" rule structurally: a finding
 * that has already been rebutted cannot be rebutted again.
 *
 * LOUD on error: if the adjudicator errors, the blocker is NOT auto-overturned —
 * the safe default is that a confirmed blocker STAYS upheld until something
 * independent clears it.
 */
import type { Finding } from "./finding.js";

/** The producer's rebuttal of a confirmed finding: its counter-evidence. */
export interface ProducerRebuttal {
  /** The producer's argument + evidence that the confirmed finding is wrong. */
  readonly argument: string;
}

/** The adjudicator's verdict on a single rebuttal. */
export interface AdjudicationVerdict {
  /** True iff the rebuttal succeeds and the blocker should be OVERTURNED. */
  readonly overturn: boolean;
  /** Reason/evidence backing the adjudication. */
  readonly note: string;
}

/**
 * Adjudicates a producer rebuttal independently. The SAME independent verifier
 * identity as the finding-verifier (NOT the original reviewer). MAY reject — a
 * rejection means the blocker stays upheld (safe default).
 */
export interface RebuttalAdjudicator {
  /** Identity of the adjudicator — must NOT be the original reviewer. */
  readonly identity: string;
  /** Adjudicate the rebuttal in a single bounded pass. */
  adjudicate(finding: Finding, rebuttal: ProducerRebuttal): Promise<AdjudicationVerdict>;
}

/** Outcome of adjudicating one rebuttal. Closed discriminated union. */
export type RebuttalOutcome =
  | { readonly status: "overturned"; readonly note: string }
  | { readonly status: "upheld"; readonly note: string };

/**
 * Tracks which findings have already used their one rebuttal, so "exactly once"
 * (D27) is enforced structurally rather than by convention. Keyed by a stable
 * finding key (file:line:reviewer:quote).
 */
export class RebuttalLedger {
  private readonly used = new Set<string>();

  private keyOf(f: Finding): string {
    return `${f.file ?? "?"}:${f.line ?? "?"}:${f.reviewer}:${f.quote}`;
  }

  /** True iff this finding has already been rebutted. */
  hasRebutted(f: Finding): boolean {
    return this.used.has(this.keyOf(f));
  }

  /** Mark this finding as having used its single rebuttal. */
  markRebutted(f: Finding): void {
    this.used.add(this.keyOf(f));
  }
}

/**
 * Adjudicate the producer's ONE rebuttal of a confirmed blocker (D27).
 *
 * @throws if the adjudicator identity equals `originalReviewer` — adjudication
 *   MUST be independent of the reviewer who raised the finding.
 * @throws if `ledger.hasRebutted(finding)` — a finding gets EXACTLY ONE rebuttal;
 *   a second attempt is a LOUD programming error, never silently re-run.
 *
 * On adjudicator error the blocker is UPHELD (safe default: a confirmed blocker
 * is not cleared by a failed adjudication).
 */
export async function adjudicateRebuttal(
  finding: Finding,
  rebuttal: ProducerRebuttal,
  adjudicator: RebuttalAdjudicator,
  originalReviewer: string,
  ledger: RebuttalLedger,
): Promise<RebuttalOutcome> {
  if (adjudicator.identity === originalReviewer) {
    throw new Error(
      `rebuttal adjudicator '${adjudicator.identity}' is the original reviewer — adjudication must be INDEPENDENT (D27)`,
    );
  }
  if (ledger.hasRebutted(finding)) {
    throw new Error(
      `finding '${finding.reviewer}@${finding.file ?? "?"}:${finding.line ?? "?"}' was already rebutted — a producer gets EXACTLY ONE rebuttal (D27)`,
    );
  }

  ledger.markRebutted(finding);

  let verdict: AdjudicationVerdict;
  try {
    verdict = await adjudicator.adjudicate(finding, rebuttal);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: "upheld", note: `adjudication errored, blocker upheld: ${detail}` };
  }

  return verdict.overturn
    ? { status: "overturned", note: verdict.note }
    : { status: "upheld", note: verdict.note };
}
