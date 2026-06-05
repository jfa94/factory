/**
 * WS6 — the single GateRunner (D26 deterministic layer; Δ V derive-don't-store).
 *
 * ONE runner orchestrates the per-gate STRATEGIES. Given a {@link GateContext}, it
 * runs each ENABLED strategy, collects GateEvidence[] from those that RAN (skips
 * are recorded but excluded from the conjunction), and DERIVES the conjunctive
 * verdict via deriveAllGatesVerdict (src/core/state/derive.ts). There is no stored
 * gate boolean and no API to inject a verdict — a verdict can ONLY come out of the
 * derive accessor over evidence a strategy produced (Δ V).
 *
 * Fail-loud: an unknown gate id throws via assertNever (closed union); an
 * all-skipped / empty-evidence run FAILS (deriveAllGatesVerdict over zero evidence
 * is false — never default-open).
 */
import { assertNever, deriveAllGatesVerdict } from "../../types/index.js";
import type { Config } from "../../config/schema.js";
import type { GateEvidence, GateVerdict } from "../../types/index.js";
import { createLogger } from "../../shared/index.js";
import type { ExemptReader } from "./tdd-exempt.js";
import { GateMemo } from "./memo.js";
import type { GateTools } from "./tools.js";
import {
  GATE_IDS,
  type GateId,
  type GateOutcome,
  type GateStrategy,
  type StrategyContext,
} from "./strategy.js";
import { testStrategy } from "./strategies/test.js";
import { tddStrategy } from "./strategies/tdd.js";
import { coverageStrategy } from "./strategies/coverage.js";
import { mutationStrategy } from "./strategies/mutation.js";
import { sastStrategy } from "./strategies/sast.js";
import { typeStrategy } from "./strategies/type.js";
import { lintStrategy } from "./strategies/lint.js";
import { buildStrategy } from "./strategies/build.js";

const log = createLogger("gate-runner");

/** Resolve the canonical strategy for a gate id. Exhaustive — throws on unknown. */
export function strategyFor(id: GateId): GateStrategy<GateTools> {
  switch (id) {
    case "test":
      return testStrategy;
    case "tdd":
      return tddStrategy;
    case "coverage":
      return coverageStrategy;
    case "mutation":
      return mutationStrategy;
    case "sast":
      return sastStrategy;
    case "type":
      return typeStrategy;
    case "lint":
      return lintStrategy;
    case "build":
      return buildStrategy;
    default:
      // Closed union: a new GateId is a deliberate compile-break here + a runtime throw.
      return assertNever(id);
  }
}

/** Everything the runner needs to run a gate sweep against one worktree. */
export interface GateContext {
  readonly runId: string;
  readonly taskId: string;
  /** Absolute path of the worktree to check. */
  readonly worktree: string;
  /** Base ref for diff-scoping (e.g. "staging"). */
  readonly baseRef: string;
  /** The resolved config — the ONE config driving every gate threshold. */
  readonly config: Config;
  /** Injected tools (real Default* or fakes). */
  readonly tools: GateTools;
  /**
   * Which gates to run. Defaults to ALL ({@link GATE_IDS}). A gate not listed is
   * simply not run (distinct from a strategy-level skip, which IS recorded).
   */
  readonly gates?: readonly GateId[];
  /** tdd_exempt resolver for the tdd strategy. */
  readonly exemptReader?: ExemptReader;
  /** Memo for tip/tree-SHA caching (Δ N/O). Defaults to a fresh per-call memo. */
  readonly memo?: GateMemo;
}

/** A per-gate record in the runner's report. */
export interface GateReportEntry {
  readonly gate: GateId;
  /** "ran" with evidence, or "skip" with a reason. */
  readonly outcome: GateOutcome;
}

/** The runner's output: the per-gate report + the DERIVED conjunctive verdict. */
export interface GateRunResult {
  /** Every gate's outcome (ran or skipped), in run order. */
  readonly report: readonly GateReportEntry[];
  /** Evidence from the gates that RAN (the conjunction inputs). */
  readonly evidence: readonly GateEvidence[];
  /** Gates that SKIPPED (excluded from the conjunction), with reasons. */
  readonly skipped: readonly { gate: GateId; reason: string }[];
  /** The freshly-DERIVED conjunctive verdict (deriveAllGatesVerdict). */
  readonly verdict: GateVerdict;
}

/**
 * The single deterministic gate runner. Stateless apart from the optional memo;
 * `run` is idempotent given identical tool outputs.
 */
export class GateRunner {
  /**
   * Run the configured gates against `ctx.worktree`, collect evidence, and return
   * the report + DERIVED verdict. A strategy that throws (a structural/loud error
   * such as truncated tool output) propagates — the runner never swallows it into a
   * silent pass.
   */
  async run(ctx: GateContext): Promise<GateRunResult> {
    const gates = ctx.gates ?? GATE_IDS;
    const memo = ctx.memo ?? new GateMemo();
    const report: GateReportEntry[] = [];
    const evidence: GateEvidence[] = [];
    const skipped: { gate: GateId; reason: string }[] = [];

    // Tree-SHA evidence memo (Δ O): one tree object sha keys the per-gate evidence
    // cache, so an identical-CONTENT re-run skips re-EXECUTING the tool. Resolved
    // ONCE up front (it is worktree-level — same for every gate). A worktree whose
    // tree is unresolvable is structurally broken; we fail LOUD rather than run
    // gates we cannot key. The cache stores EVIDENCE only — the verdict is still
    // re-derived by deriveAllGatesVerdict, so a hit never bypasses re-derivation.
    const treeSha = await ctx.tools.git.treeSha({ cwd: ctx.worktree });

    for (const id of gates) {
      const cached = memo.getEvidence(id, treeSha);
      if (cached !== undefined) {
        report.push({ gate: id, outcome: { kind: "ran", evidence: cached } });
        evidence.push(cached);
        log.debug(`gate ${id} served from tree-SHA evidence memo (${treeSha})`);
        continue;
      }
      const strategy = strategyFor(id);
      const sctx: StrategyContext<GateTools> = {
        runId: ctx.runId,
        taskId: ctx.taskId,
        worktree: ctx.worktree,
        baseRef: ctx.baseRef,
        config: ctx.config,
        tools: ctx.tools,
        exemptReader: ctx.exemptReader,
        memo,
      };
      const outcome = await strategy.run(sctx);
      report.push({ gate: id, outcome });
      if (outcome.kind === "ran") {
        evidence.push(outcome.evidence);
        memo.putEvidence(id, treeSha, outcome.evidence);
      } else {
        // Skips are not memoized: they carry no evidence, are excluded from the
        // conjunction, and are cheap to re-evaluate (a not-applicable probe).
        skipped.push({ gate: outcome.gate, reason: outcome.reason });
        log.debug(`gate ${id} skipped: ${outcome.reason}`);
      }
    }

    // DERIVE the verdict — never store a boolean. Empty evidence (all skipped) ⇒
    // FAILS by the deriveAllGatesVerdict contract.
    const verdict = deriveAllGatesVerdict(evidence);
    return { report, evidence, skipped, verdict };
  }
}
