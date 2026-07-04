/**
 * WS8 — the injectable PRODUCER-AGENT boundary (mirrors WS5 {@link
 * import("../spec/agents.js").SpecAgentRunner} and WS7 FindingVerifierRunner).
 *
 * The producer is the two TDD-ordered roles: `test-writer` (commits the failing
 * tests first) and `implementer` (commits the minimal implementation, or PATCHES
 * forward over confirmed blockers). An agent cannot deterministically spawn a
 * real `Agent()` inside a unit, so — exactly like WS5/WS7 — this module owns the
 * CONTRACT and the parse of the agent's terminal STATUS line, while the WS10
 * in-session runner performs the live spawn. Units inject a {@link
 * ProducerAgentRunner} fake (see fakes.ts) so the ladder / fix-forward / classify
 * logic is testable without an LLM, Codex, or any gate binary.
 *
 * The {@link ProducerOutcome} is a CLOSED discriminated union parsed from the
 * implementer's terminal STATUS line (agents/implementer.md): `done`,
 * `blocked-escalate` (a spec-defect signal the producer itself raises),
 * `test-defective` (the implementer reports the RED test ITSELF is wrong — a
 * RECOVERABLE signal that regenerates the test, not a spec defect), `needs-context`
 * (the implementer wants more context — a fix-forward / retry signal, NOT a
 * failure), and `error` (the spawn itself failed). Classify-before-retry
 * (classify.ts) reads this union to decide whether a failure burns a rung or fails
 * immediately (Δ D).
 */
import type {ProducerRole} from '../types/index.js'
import type {ProducerContext} from './prompt-context.js'

/** The producer roles, re-exported as the WS8 vocabulary (TDD order: tests first). */
export type {ProducerRole} from '../types/index.js'

/**
 * A producer spawn request the WS10 runner consumes to launch the agent. `model`
 * is the DIALED model (model-dial.ts) — never a literal here; `injectedContext`
 * carries the rung-2 prior-failure "don't do this" summary (empty on rung 0/1).
 */
export interface ProducerSpawn {
    /** Which producer role to spawn (test-writer first, then implementer). */
    readonly role: ProducerRole
    /**
     * The model to spawn on — the WS5/WS4 dial output for the current rung
     * (model-dial.ts). NEVER a hardcoded model id.
     */
    readonly model: string
    /** Max agent turns (config.testWriter.maxTurns / a producer cap). */
    readonly maxTurns: number
    /** Structured prompt context (prompt-context.ts assembles it). */
    readonly context: ProducerContext
}

/**
 * The CLOSED outcome of one producer spawn, parsed from the agent's terminal
 * STATUS line. Discriminated on `status`:
 *   - `done`             — the role completed (tests committed / impl committed).
 *   - `blocked-escalate` — the producer itself reports the TASK is unworkable as
 *                          specified (e.g. "STATUS: BLOCKED — escalate", an
 *                          untestable / contradictory criterion). A SPEC-DEFECT
 *                          signal — classify.ts routes it straight to a failure,
 *                          NEVER a re-exec (Δ D).
 *   - `test-defective`   — the implementer reports the pre-committed RED test is
 *                          ITSELF wrong (it pins a wrong literal / can't be made
 *                          green without breaking a confirmed-correct fix). A
 *                          RECOVERABLE signal — classify.ts routes it to a retry
 *                          that regenerates the test (resumed at the `tests` phase),
 *                          bounded by the escalation cap. The implementer NEVER edits
 *                          the test; only the test-writer re-run replaces it.
 *   - `needs-context`    — the implementer could not finish but the task is workable
 *                          with more context / a stronger model. A RETRY signal
 *                          (the ladder may bump a rung), not a failure.
 *   - `error`            — the spawn itself failed (the agent crashed / produced
 *                          no parseable STATUS). LOUD + unresolved; treated as a
 *                          retryable producer failure, never an auto-advance.
 */
export type ProducerOutcome =
    | {readonly status: 'done'}
    | {readonly status: 'blocked-escalate'; readonly reason: string}
    | {readonly status: 'test-defective'; readonly reason: string}
    | {readonly status: 'needs-context'; readonly reason: string}
    | {readonly status: 'error'; readonly reason: string}

/**
 * The injectable producer-agent boundary. The real impl (WS10) drives a live
 * `Agent()` spawn from a {@link ProducerSpawn} and parses the terminal STATUS
 * line via {@link parseProducerStatus}; units inject a fake.
 */
export interface ProducerAgentRunner {
    /** Run one producer spawn (test-writer or implementer) and return its outcome. */
    run(spawn: ProducerSpawn): Promise<ProducerOutcome>
}

/**
 * Parse an implementer's terminal STATUS line into a {@link ProducerOutcome}
 * (agents/implementer.md). LOUD-ish but tolerant of trailing detail:
 *   - `STATUS: DONE` / `STATUS: DONE_WITH_CONCERNS`   → `done`
 *   - `STATUS: BLOCKED — escalate: test requires revision` → `test-defective`
 *   - `STATUS: BLOCKED — escalate`                    → `blocked-escalate` (spec-defect)
 *   - `STATUS: NEEDS_CONTEXT`                         → `needs-context`
 *   - anything else / empty                           → `error` (no parseable verdict)
 *
 * The match is on the FIRST recognised keyword so cosmetic punctuation/casing
 * around it does not change the verdict. An unrecognised line is `error`, never
 * silently `done` — a producer must not advance on an unparseable status.
 */
export function parseProducerStatus(raw: string): ProducerOutcome {
    const line = raw.trim()
    const upper = line.toUpperCase()

    // BLOCKED must be checked before DONE: a "BLOCKED — escalate" line could
    // otherwise be mis-read if the keywords co-occur. The escalate signal wins.
    if (upper.includes('BLOCKED') && upper.includes('ESCALATE')) {
        // The CONTIGUOUS phrase "test requires revision" distinguishes a wrong RED
        // test (recoverable — regenerate the test) from a genuine spec contradiction
        // (terminal spec-defect). Contiguity is deliberate: a non-contiguous mention
        // like "the criterion for the test requires revision" stays a spec-defect.
        if (upper.includes('TEST REQUIRES REVISION')) {
            return {status: 'test-defective', reason: line}
        }
        return {status: 'blocked-escalate', reason: line}
    }
    if (upper.includes('NEEDS_CONTEXT') || upper.includes('NEEDS CONTEXT')) {
        return {status: 'needs-context', reason: line}
    }
    // Leading-keyword anchor: must start with (optional "STATUS:") then "DONE" as a
    // whole word, OR the scribe's documented `DONE_WITH_CONCERNS` success-with-note
    // variant (agents/scribe.md) — `_` is a word char, so a bare `DONE\b` rejects it
    // and would suspend a docs stage the scribe actually finished (S12 smoke defect).
    // A bare includes("DONE") silently matches "NOT DONE" and "ABANDONED" (contains
    // "done" in "aban-DONE-d"). The strict direction is correct: a false-negative is a
    // loud producer error retry; a false-positive is a silent wrong success.
    // eslint-disable-next-line security/detect-unsafe-regex -- safe-regex false positive: bounded `?` groups, the two `\s*` separated by a literal `:`; ReDoS-audited linear
    if (/^(?:STATUS\s*:\s*)?DONE(?:_WITH_CONCERNS)?\b/.test(upper)) {
        return {status: 'done'}
    }
    return {
        status: 'error',
        reason: line.length > 0 ? `unparseable producer status: ${line}` : 'empty producer status',
    }
}
