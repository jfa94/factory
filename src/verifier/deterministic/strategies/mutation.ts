/**
 * WS6 — mutation gate strategy (blob-scoped rollup, Δ O).
 *
 * Ported from bin/pipeline-mutation-gate + templates/.github/workflows/
 * quality-gate.yml (scope lines 86-96). Mirrors CI exactly:
 *   1. Compute scope from `diff --diff-filter=AM origin/<base>...HEAD` glob
 *      `src/**\/*.ts` MINUS the exclusions (test/spec/d.ts, types/, data/, index.ts).
 *      EMPTY scope ⇒ SKIP "no-mutable-changes" (exit 0 in bash; here a GateSkip so
 *      it is excluded from the conjunction, never a default pass).
 *   2. Require origin/<base> to exist (else fail-closed "base-missing").
 *   3. Run stryker --mutate <csv>. A DERIVABLE score is authoritative over the exit
 *      code: a present report with a non-null score is compared against the target
 *      regardless of stryker's `break` exit (the factory's target, not CI's bar).
 *   4. Only when NO score is derivable does the exit matter: non-zero ⇒
 *      "stryker-failed"; else (green) no report ⇒ "no-report", report w/o derivable
 *      score ⇒ "no-score" (both fail-closed — bash A2/T4d).
 *   5. STRICT float compare (no half-up rounding): score < target ⇒
 *      "score-below-target"; score >= target ⇒ pass (T4b2/T4b3/T4b4 boundaries).
 *      The score is DERIVED in-engine from the stock json report's per-file mutant
 *      tally (extractMutationScore) — the stock reporter emits no `.metrics`.
 *
 * Target comes from `quality.mutationScoreTarget` (the ONE config).
 *
 * Applicability (Δ skip): a project that never opted into stryker must NOT
 * fail-close every task. The gate is applicable ONLY when BOTH the stryker binary
 * resolves in the worktree AND a stryker config is present; otherwise it SKIPS
 * (mirroring the sast "no-security-command" precedent). Checked BEFORE base/scope
 * so a repo without mutation tooling skips cleanly rather than driving `npx stryker`
 * into a not-installed failure.
 */
import type { GateOutcome, GateStrategy, StrategyContext } from "../strategy.js";
import { ran, skip } from "../strategy.js";
import { mutationScope } from "../scope.js";
import type { GateTools } from "../tools.js";

/** Strict float compare: pass IFF score >= target (no rounding). */
export function scorePasses(score: number, target: number): boolean {
  return score >= target;
}

/** Stryker config filenames that mark mutation testing as opted-in. */
export const STRYKER_CONFIGS = [
  "stryker.config.json",
  "stryker.config.js",
  "stryker.config.mjs",
  "stryker.config.cjs",
  "stryker.conf.json",
  "stryker.conf.js",
  ".stryker.config.json",
  ".stryker.conf.json",
] as const;

/** Worktree-relative path the stryker binary resolves to after `npm install`. */
export const STRYKER_BIN = "node_modules/.bin/stryker";

export const mutationStrategy: GateStrategy<GateTools> = {
  id: "mutation",
  async run(ctx: StrategyContext<GateTools>): Promise<GateOutcome> {
    const target = ctx.config.quality.mutationScoreTarget;
    const opts = { cwd: ctx.worktree };

    // Applicability first: no stryker tooling/config ⇒ NOT APPLICABLE (skip).
    if (!(await ctx.tools.fs.exists(STRYKER_BIN, opts))) {
      return skip("mutation", "no-mutation-binary");
    }
    if (!(await ctx.tools.fs.existsAny(STRYKER_CONFIGS, opts))) {
      return skip("mutation", "no-mutation-config");
    }

    const base = `origin/${ctx.baseRef}`;

    // Fail-closed if the base ref is absent — without it we cannot reproduce CI's
    // scope (bin/pipeline-mutation-gate:77-80).
    if (!(await ctx.tools.git.refExists(base, opts))) {
      return ran("mutation", false, `base-missing: ${base} not found`);
    }

    const changed = await ctx.tools.git.changedFiles(base, opts);
    const scope = mutationScope(changed);
    if (scope.length === 0) {
      return skip("mutation", "no-mutable-changes");
    }

    const result = await ctx.tools.stryker.run(scope, opts);
    if (result.proc.truncated) {
      throw new Error(
        "mutation gate: stryker report truncated — refusing to parse a clipped payload",
      );
    }
    const report = result.report;
    // A present, derivable score is AUTHORITATIVE — compare against the factory's
    // own `mutationScoreTarget` regardless of stryker's exit code. Target repos gate
    // CI via stryker's `break: N` threshold (a non-zero exit when CI's bar isn't
    // met); that bar must NOT double-gate the factory's independent target here. Only
    // when no score is derivable does the exit code matter (a crash before scoring).
    if (report.report === "present" && report.mutationScore !== null) {
      const score = report.mutationScore;
      return scorePasses(score, target)
        ? ran("mutation", true, `mutation score ${score} >= ${target} (scope ${scope.length})`)
        : ran("mutation", false, `score-below-target: ${score} < ${target}`);
    }
    // No derivable score. A non-zero exit means stryker crashed BEFORE producing one.
    if (result.proc.code !== 0) {
      return ran("mutation", false, `stryker-failed: exit=${result.proc.code ?? "null"}`);
    }
    // Green exit but still no score: scope is non-empty, so an absent / unparseable /
    // score-less report is an anomaly → fail-closed (bash A2 / T4d), never a waive.
    if (report.report === "absent") {
      return ran("mutation", false, "no-report: stryker produced no report despite mutable files");
    }
    if (report.report === "unparseable") {
      return ran("mutation", false, "unparseable-report: stryker report JSON did not parse");
    }
    return ran("mutation", false, "no-score: report has no derivable mutation score");
  },
};
