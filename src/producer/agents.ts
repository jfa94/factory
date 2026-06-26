/**
 * WS8 — the injectable PRODUCER-AGENT boundary (mirrors WS5 {@link
 * import("../spec/agents.js").SpecAgentRunner} and WS7 FindingVerifierRunner).
 *
 * The producer is the two TDD-ordered roles: `test-writer` (commits the failing
 * tests first) and `implementer` (commits the minimal implementation, or PATCHES
 * forward over confirmed blockers). An agent cannot deterministically spawn a
 * real `Agent()` inside a unit, so — exactly like WS5/WS7 — this module owns the
 * CONTRACT and the parse of the agent's terminal STATUS line, while the WS10
 * in-session driver performs the live spawn. Units inject a {@link
 * ProducerAgentRunner} fake (see fakes.ts) so the ladder / fix-forward / classify
 * logic is testable without an LLM, Codex, or any gate binary.
 *
 * The {@link ProducerOutcome} is a CLOSED discriminated union parsed from the
 * implementer's terminal STATUS line (agents/implementer.md): `done`,
 * `blocked-escalate` (a spec-defect signal the producer itself raises),
 * `needs-context` (the implementer wants more context — a fix-forward / retry
 * signal, NOT a failure), and `error` (the spawn itself failed). Classify-before-
 * retry (classify.ts) reads this union to decide whether a failure burns a rung
 * or fails immediately (Δ D).
 */
import type { ProducerRole } from "../types/index.js";
import type { ProducerContext } from "./prompt-context.js";

/** The producer roles, re-exported as the WS8 vocabulary (TDD order: tests first). */
export type { ProducerRole } from "../types/index.js";

/**
 * A producer spawn request the WS10 driver consumes to launch the agent. `model`
 * is the DIALED model (model-dial.ts) — never a literal here; `injectedContext`
 * carries the rung-2 prior-failure "don't do this" summary (empty on rung 0/1).
 */
export interface ProducerSpawn {
  /** Which producer role to spawn (test-writer first, then implementer). */
  readonly role: ProducerRole;
  /**
   * The model to spawn on — the WS5/WS4 dial output for the current rung
   * (model-dial.ts). NEVER a hardcoded model id.
   */
  readonly model: string;
  /** Max agent turns (config.testWriter.maxTurns / a producer cap). */
  readonly maxTurns: number;
  /** Structured prompt context (prompt-context.ts assembles it). */
  readonly context: ProducerContext;
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
 *   - `needs-context`    — the implementer could not finish but the task is workable
 *                          with more context / a stronger model. A RETRY signal
 *                          (the ladder may bump a rung), not a failure.
 *   - `error`            — the spawn itself failed (the agent crashed / produced
 *                          no parseable STATUS). LOUD + unresolved; treated as a
 *                          retryable producer failure, never an auto-advance.
 */
export type ProducerOutcome =
  | { readonly status: "done" }
  | { readonly status: "blocked-escalate"; readonly reason: string }
  | { readonly status: "needs-context"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string };

/**
 * The injectable producer-agent boundary. The real impl (WS10) drives a live
 * `Agent()` spawn from a {@link ProducerSpawn} and parses the terminal STATUS
 * line via {@link parseProducerStatus}; units inject a fake.
 */
export interface ProducerAgentRunner {
  /** Run one producer spawn (test-writer or implementer) and return its outcome. */
  run(spawn: ProducerSpawn): Promise<ProducerOutcome>;
}

/**
 * Parse an implementer's terminal STATUS line into a {@link ProducerOutcome}
 * (agents/implementer.md). LOUD-ish but tolerant of trailing detail:
 *   - `STATUS: DONE`               → `done`
 *   - `STATUS: BLOCKED — escalate` → `blocked-escalate` (spec-defect signal)
 *   - `STATUS: NEEDS_CONTEXT`      → `needs-context`
 *   - anything else / empty        → `error` (no parseable verdict)
 *
 * The match is on the FIRST recognised keyword so cosmetic punctuation/casing
 * around it does not change the verdict. An unrecognised line is `error`, never
 * silently `done` — a producer must not advance on an unparseable status.
 */
export function parseProducerStatus(raw: string): ProducerOutcome {
  const line = raw.trim();
  const upper = line.toUpperCase();

  // BLOCKED must be checked before DONE: a "BLOCKED — escalate" line could
  // otherwise be mis-read if the keywords co-occur. The escalate signal wins.
  if (upper.includes("BLOCKED") && upper.includes("ESCALATE")) {
    return { status: "blocked-escalate", reason: line };
  }
  if (upper.includes("NEEDS_CONTEXT") || upper.includes("NEEDS CONTEXT")) {
    return { status: "needs-context", reason: line };
  }
  if (upper.includes("DONE")) {
    return { status: "done" };
  }
  return {
    status: "error",
    reason: line.length > 0 ? `unparseable producer status: ${line}` : "empty producer status",
  };
}
