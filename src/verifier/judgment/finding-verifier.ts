/**
 * WS7 — VERIFY-THEN-FIX independent finding-verifier (Decision 27).
 *
 * THE INVARIANT: a blocking finding reaches the PRODUCER only after an INDEPENDENT
 * verifier — fresh context, adversarial framing, a SINGLE bounded pass — confirms
 * it against ground truth. This is the structural defence against a reviewer
 * sending the producer off to "fix" a finding that does not actually hold.
 *
 * Independence + framing (D27):
 *   - The verifier is a DIFFERENT identity from the finder (cross-vendor where
 *     available, else same-vendor with a fresh context). The runner records its
 *     identity; {@link confirmBlocker} asserts it is not the finder.
 *   - The prompt is framed "does this finding hold against the code?", never "is
 *     this a false alarm?" — the framing lives in the runner contract, and the
 *     orientation is fixed so the verifier is not nudged toward dismissal.
 *
 * Bounded (D27): EXACTLY ONE runner call per finding. There is no debate loop, no
 * re-ask. The runner is injected ({@link FindingVerifierRunner}) so units never
 * spawn a real agent.
 *
 * LOUD on error: a runner that throws does NOT auto-confirm and does NOT
 * auto-refute — it surfaces as `error`, an UNRESOLVED outcome the caller must
 * handle (it must never silently let the finding through OR drop it).
 */
import type { Finding } from "./finding.js";

/** Ground-truth evidence the verifier inspected (audit trail). */
export interface VerifierEvidence {
  /** Free-form evidence the verifier cites (e.g. the matched source span). */
  readonly note: string;
}

/**
 * The outcome of ONE independent verification pass. Closed discriminated union:
 *   - `confirmed` — the finding holds; forward it to the producer.
 *   - `refuted`   — the finding does not hold; it is NOT forwarded.
 *   - `error`     — the verifier could not produce a usable verdict (LOUD,
 *     UNRESOLVED). Never treated as confirm or refute.
 */
export type VerifierOutcome =
  | { readonly status: "confirmed"; readonly evidence: VerifierEvidence }
  | { readonly status: "refuted"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string };

/**
 * What a runner returns for a confirmation request. The runner answers the fixed
 * adversarial question "does this finding hold against the code?" — `holds: true`
 * ⇒ confirmed, `holds: false` ⇒ refuted. The runner CANNOT return "error": a
 * thrown error is the error channel (kept distinct so a runner cannot smuggle an
 * unresolved state through as a verdict).
 */
export interface VerifierVerdict {
  /** True iff the finding holds against the code (confirmed). */
  readonly holds: boolean;
  /** Evidence/reason backing the verdict. */
  readonly note: string;
}

/**
 * Runs ONE independent, bounded confirmation pass for a finding. Injected so units
 * test without spawning an agent. Implementations spawn a fresh-context verifier
 * (cross-vendor where available, recorded via {@link identity}). MAY reject — a
 * rejection becomes the `error` outcome, never an auto-confirm.
 */
export interface FindingVerifierRunner {
  /**
   * A STABLE identity for this verifier (e.g. "codex" or "claude:fresh"). Used to
   * assert the verifier is independent of the finder (different identity).
   */
  readonly identity: string;
  /** Run the single bounded confirmation pass. */
  confirm(finding: Finding): Promise<VerifierVerdict>;
}

/**
 * Independently confirm a single blocking finding (D27). Runs the injected runner
 * EXACTLY ONCE.
 *
 * @throws if the runner identity equals the finder identity — that would defeat
 *   the independence invariant, so it is a LOUD programming error, not a silent
 *   downgrade.
 */
export async function confirmBlocker(
  finding: Finding,
  runner: FindingVerifierRunner,
  finderIdentity: string,
): Promise<VerifierOutcome> {
  if (runner.identity === finderIdentity) {
    throw new Error(
      `finding-verifier identity '${runner.identity}' equals the finder's — the verifier must be INDEPENDENT (D27)`,
    );
  }

  let verdict: VerifierVerdict;
  try {
    verdict = await runner.confirm(finding);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // LOUD + UNRESOLVED: a verifier error never auto-confirms and never silently
    // drops the finding. The caller must decide (and must not ship past it).
    return { status: "error", reason: `finding-verifier errored: ${detail}` };
  }

  return verdict.holds
    ? { status: "confirmed", evidence: { note: verdict.note } }
    : { status: "refuted", reason: verdict.note };
}
