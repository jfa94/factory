/**
 * WS8 — CLASSIFY-BEFORE-RETRY (Δ D): the pure decision that decides whether a
 * producer/verify failure is RETRYABLE (burns an escalation rung) or routes
 * STRAIGHT to a classified loud failure — WITHOUT burning a rung (Decision 22/25).
 *
 * The load-bearing rule (Δ D): a DETERMINISTIC / SPEC-DEFECT / INTEGRATION-
 * ENVIRONMENTAL failure is not something a stronger producer model can fix, so
 * re-executing it would only waste retries. Such a failure is classified and
 * failed immediately. Only a CAPABILITY failure — the producer plausibly does
 * better with a fresh context / stronger model — burns a rung.
 *
 * This is a pure function over a {@link FailureSignal} (a closed union over the
 * sources WS8 sees): the producer's terminal STATUS, a panel verifier-error, an
 * unfixable deterministic gate, and an explicit environmental marker. It returns
 * a {@link ClassifyDecision}: either `retry` or `fail` with a closed
 * {@link FailureClass} + reason. No re-exec is attempted for a `fail`.
 */
import type {FailureClass} from '../types/index.js'

/**
 * A failure signal WS8 must classify. CLOSED discriminated union on `kind`:
 *   - `producer-status`   — the producer's own terminal outcome (agents.ts).
 *     `blocked-escalate` ⇒ spec-defect (immediate fail); `test-defective` ⇒
 *     capability (retryable — regenerate the RED test); `needs-context` /
 *     `error` ⇒ capability (retryable).
 *   - `verifier-error`    — the panel had an UNRESOLVED verifier error
 *     (PanelRunResult.hadVerifierError). LOUD + unresolved — retryable (re-run
 *     the bounded verify), NEVER an auto-advance, NEVER a silent fail.
 *   - `gate-failure`      — a deterministic gate failed. `structurallyUnfixable`
 *     ⇒ spec-defect (e.g. an untestable / contradictory criterion the producer
 *     cannot satisfy); otherwise capability (a failing test/coverage/type/lint
 *     the producer can plausibly fix).
 *   - `environmental`     — an external blocker (CI infra, network, a missing
 *     dependency the task cannot itself provision). Always immediate fail.
 *   - `merge-gate-blocked`     — the merge gate is blocked by CONFIRMED blockers
 *     with no other terminal signal — the producer should fix-forward / retry
 *     (capability), unless the rung budget is exhausted (the ladder, not this
 *     classifier, decides the cap).
 */
export type FailureSignal =
    | {
          readonly kind: 'producer-status'
          readonly status: 'blocked-escalate' | 'test-defective' | 'needs-context' | 'error'
          readonly reason: string
      }
    | {readonly kind: 'verifier-error'; readonly reason: string}
    | {
          readonly kind: 'gate-failure'
          readonly gate: string
          readonly structurallyUnfixable: boolean
          readonly reason: string
      }
    | {readonly kind: 'environmental'; readonly reason: string}
    | {readonly kind: 'merge-gate-blocked'; readonly reason: string}

/**
 * The classification result. CLOSED:
 *   - `retry` — re-exec is worthwhile; the ladder may bump a rung (within cap).
 *   - `fail`  — an IMMEDIATE classified loud fail (does NOT burn a rung); carries
 *     a closed {@link FailureClass} + a non-empty reason for the partial-run
 *     report (Decision 22).
 */
export type ClassifyDecision =
    | {readonly action: 'retry'; readonly reason: string}
    | {readonly action: 'fail'; readonly failureClass: FailureClass; readonly reason: string}

/** Exhaustiveness primitive local to WS8 (mirrors the WS2 assertNever discipline). */
function exhaustive(x: never): never {
    throw new Error(`classify: unhandled FailureSignal ${JSON.stringify(x)}`)
}

/**
 * Classify a failure signal into a retry-or-fail decision (Δ D). PURE.
 *
 * Fail-immediately (does not burn a rung):
 *   - producer `blocked-escalate`           → spec-defect
 *   - gate-failure `structurallyUnfixable`  → spec-defect
 *   - environmental                         → blocked-environmental
 *
 * Retry (a rung may be burned by the ladder, within the cap):
 *   - producer `test-defective`             → capability (regenerate the RED test)
 *   - producer `needs-context` / `error`    → capability
 *   - gate-failure (fixable)                → capability
 *   - verifier-error (LOUD, re-run verify)  → capability
 *   - merge-gate-blocked (fix-forward)           → capability
 */
export function classifyFailure(signal: FailureSignal): ClassifyDecision {
    switch (signal.kind) {
        case 'producer-status': {
            if (signal.status === 'blocked-escalate') {
                // The producer itself reports the task is unworkable as specified — a
                // spec defect. Re-exec on a stronger model cannot fix the target.
                return {
                    action: 'fail',
                    failureClass: 'spec-defect',
                    reason: `producer reported the task unworkable as specified: ${signal.reason}`,
                }
            }
            if (signal.status === 'test-defective') {
                // The implementer reports the RED test itself is wrong. Re-running the
                // TEST-WRITER (resume phase chosen by the caller, transitions.ts) with the
                // defect fed back can regenerate a correct test — so this is RETRYABLE, not
                // a terminal spec-defect. The ladder bounds it by the escalation cap.
                return {action: 'retry', reason: `RED test reported defective: ${signal.reason}`}
            }
            // needs-context / error: a stronger model or fresh context may succeed.
            return {action: 'retry', reason: signal.reason}
        }
        case 'gate-failure': {
            if (signal.structurallyUnfixable) {
                return {
                    action: 'fail',
                    failureClass: 'spec-defect',
                    reason: `deterministic gate '${signal.gate}' is structurally unfixable by the producer: ${signal.reason}`,
                }
            }
            return {action: 'retry', reason: `gate '${signal.gate}' failed: ${signal.reason}`}
        }
        case 'environmental': {
            return {
                action: 'fail',
                failureClass: 'blocked-environmental',
                reason: `environmental blocker: ${signal.reason}`,
            }
        }
        case 'verifier-error': {
            // LOUD + unresolved: never auto-advance, never silently fail. Re-run the
            // bounded verify (the ladder/verify-retry budget bounds it).
            return {action: 'retry', reason: `verifier error (unresolved): ${signal.reason}`}
        }
        case 'merge-gate-blocked': {
            // Confirmed blockers remain — fix-forward / retry.
            return {action: 'retry', reason: signal.reason}
        }
        default:
            return exhaustive(signal)
    }
}
