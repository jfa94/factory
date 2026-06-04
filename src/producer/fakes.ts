/**
 * WS8 — exported FAKES for WS8's own unit tests and downstream consumers.
 *
 * Mirrors the WS6 `makeFakeTools` / WS7 runner-fake precedent: a scriptable
 * {@link FakeProducerAgentRunner} (canned {@link ProducerOutcome} per call, so a
 * test can drive the ladder rung-by-rung), a {@link FakeRebuttalAdjudicator}
 * (canned overturn/uphold), and a {@link FakeVendorProbe} — so the ladder /
 * classify / fix-forward tests run without a real Agent(), Codex, or gate binary.
 */
import type { ProducerAgentRunner, ProducerOutcome, ProducerSpawn } from "./agents.js";
import type { VerifyPass, VerifyPassResult } from "./ladder.js";
import type { Finding } from "../verifier/judgment/finding.js";
import type {
  AdjudicationVerdict,
  ProducerRebuttal,
  RebuttalAdjudicator,
} from "../verifier/judgment/rebuttal.js";
import type { VendorProbe } from "../verifier/judgment/vendor.js";

/**
 * A scriptable producer-agent runner. Returns the next outcome from `script` on
 * each {@link run}; records every spawn it was called with (for asserting the
 * model/context CHANGED per rung). Throws if the script is exhausted — a test that
 * spawns more times than scripted is a LOUD test bug, never a silent default.
 */
export class FakeProducerAgentRunner implements ProducerAgentRunner {
  /** Every spawn this runner was asked to run, in order (for assertions). */
  readonly spawns: ProducerSpawn[] = [];
  private readonly script: ProducerOutcome[];
  private idx = 0;

  constructor(script: readonly ProducerOutcome[]) {
    this.script = [...script];
  }

  run(spawn: ProducerSpawn): Promise<ProducerOutcome> {
    this.spawns.push(spawn);
    const next = this.script[this.idx];
    if (next === undefined) {
      throw new Error(
        `FakeProducerAgentRunner: script exhausted after ${this.idx} call(s) — the ladder spawned more times than expected`,
      );
    }
    this.idx += 1;
    return Promise.resolve(next);
  }
}

/**
 * A scriptable verify pass. Returns the next {@link VerifyPassResult} from
 * `script` on each call; throws when exhausted (a LOUD test bug).
 */
export function makeFakeVerify(script: readonly VerifyPassResult[]): VerifyPass {
  const queue = [...script];
  let idx = 0;
  return () => {
    const next = queue[idx];
    if (next === undefined) {
      throw new Error(
        `makeFakeVerify: script exhausted after ${idx} call(s) — verify was run more times than expected`,
      );
    }
    idx += 1;
    return Promise.resolve(next);
  };
}

/** A verify result with no blockers and no error — the "floor clear" case. */
export const VERIFY_CLEAR: VerifyPassResult = {
  confirmedBlockers: [],
  hadVerifierError: false,
};

/** A verify result with confirmed blockers (floor blocked). */
export function verifyBlocked(blockers: readonly Finding[]): VerifyPassResult {
  return { confirmedBlockers: blockers, hadVerifierError: false };
}

/** A verify result with a LOUD unresolved verifier error. */
export const VERIFY_ERROR: VerifyPassResult = {
  confirmedBlockers: [],
  hadVerifierError: true,
};

/**
 * A verify result carrying a STRUCTURALLY-UNFIXABLE gate failure (Δ D) — the
 * ladder must drop immediately (spec-defect) WITHOUT burning a rung.
 */
export function verifyStructuralGate(
  gate: string,
  reason = `gate '${gate}' is structurally unfixable as specified`,
): VerifyPassResult {
  return {
    confirmedBlockers: [],
    hadVerifierError: false,
    structuralFailure: { kind: "gate-failure", gate, structurallyUnfixable: true, reason },
  };
}

/**
 * A verify result carrying an ENVIRONMENTAL blocker (Δ D) — the ladder must drop
 * immediately (blocked-environmental) WITHOUT burning a rung.
 */
export function verifyEnvironmental(reason = "CI infrastructure unavailable"): VerifyPassResult {
  return {
    confirmedBlockers: [],
    hadVerifierError: false,
    structuralFailure: { kind: "environmental", reason },
  };
}

/**
 * A canned rebuttal adjudicator (WS7 type). `overturn` controls every verdict.
 * `identity` defaults to "codex" — pass a value equal to the original reviewer in
 * a test to exercise WS7's independence throw.
 */
export class FakeRebuttalAdjudicator implements RebuttalAdjudicator {
  readonly identity: string;
  private readonly verdict: AdjudicationVerdict;

  constructor(overturn: boolean, identity = "codex", note = "fake adjudication") {
    this.identity = identity;
    this.verdict = { overturn, note };
  }

  adjudicate(_finding: Finding, _rebuttal: ProducerRebuttal): Promise<AdjudicationVerdict> {
    return Promise.resolve(this.verdict);
  }
}

/** A fake vendor probe. `present` toggles availability; `throws` simulates ENOENT. */
export class FakeVendorProbe implements VendorProbe {
  readonly vendor: string;
  private readonly present: boolean;
  private readonly throws: boolean;

  constructor(opts: { vendor?: string; present: boolean; throws?: boolean }) {
    this.vendor = opts.vendor ?? "codex";
    this.present = opts.present;
    this.throws = opts.throws ?? false;
  }

  available(): Promise<boolean> {
    if (this.throws) {
      return Promise.reject(new Error(`spawn ${this.vendor} ENOENT`));
    }
    return Promise.resolve(this.present);
  }
}

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
