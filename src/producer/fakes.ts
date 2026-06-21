/**
 * Test fixture for the producer unit tests: a minimal {@link Finding} builder.
 *
 * (The ladder/fix-forward/rebuttal fakes that once lived here were removed with the
 * dead ladder cluster — the driver re-expresses escalation via `escalation_rung`,
 * so there is no in-module ladder to drive rung-by-rung.)
 */
import type { Finding } from "../verifier/judgment/index.js";

/** Build a minimal {@link Finding} for tests (citable by default). */
export function fakeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: overrides.reviewer ?? "security-reviewer",
    severity: overrides.severity ?? "critical",
    blocking: overrides.blocking ?? true,
    file: overrides.file ?? "src/x.ts",
    line: overrides.line ?? 10,
    quote: overrides.quote ?? "const secret = process.env.KEY",
    description: overrides.description ?? "hardcoded secret path",
  };
}
