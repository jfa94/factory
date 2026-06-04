/**
 * WS6 — TDD gate strategy (Δ N).
 *
 * Pinned to the PRE-SQUASH branch tip (base..HEAD before squash-merge), MEMOIZED
 * by tip SHA, and a structural NO-OP on squashed history.
 *
 * Flow:
 *   1. Resolve the base ref (prefer origin/<base>, fall back to a local <base> —
 *      mirrors bin/pipeline-tdd-gate:30-37). Missing ⇒ fail-closed.
 *   2. Tip-SHA memo (Δ N): if we already classified this tip, return the memoized
 *      verdict WITHOUT re-running diff-tree (also the squashed-history no-op: a
 *      second invocation on the same squashed tip is served from memo).
 *   3. Squash NO-OP detection: a single commit in base..HEAD whose changes
 *      include impl AND tests together is the squashed shape — the per-task TDD
 *      ordering is unverifiable post-squash, so the gate is a NO-OP (pass) rather
 *      than a false violation. (A genuine single impl-only commit on the per-task
 *      branch is still a violation — see deriveTddVerdict.)
 *   4. Classify base..HEAD (oldest-first) via the pure {@link deriveTddVerdict}.
 *   5. observed = verdict.ok. Memoize by tip SHA.
 *
 * The verdict is converted to GateEvidence; the RUNNER derives the GateVerdict
 * (derive-don't-store). tdd_exempt is read from tasks.json/package.json via the
 * injected ExemptReader — never state.json.
 */
import type { GateOutcome, GateStrategy, StrategyContext } from "../strategy.js";
import { ran } from "../strategy.js";
import { isTestPath } from "../scope.js";
import type { GateTools, ToolRunOpts } from "../tools.js";
import { deriveTddVerdict, type TddVerdict } from "../tdd-classify.js";

/**
 * Is the base..HEAD shape a squashed history? Heuristic ported to the Node flow:
 * exactly ONE commit that introduces BOTH a test file and an impl file is the
 * squash-merge shape (the per-task branch's test/impl commits collapsed into one),
 * which cannot be ordering-checked — so the gate is a no-op. A single commit that
 * is test-only or impl-only is NOT a squash and is classified normally.
 */
export function isSquashedHistory(commitFiles: readonly (readonly string[])[]): boolean {
  if (commitFiles.length !== 1) return false;
  const files = commitFiles[0]!;
  const hasTest = files.some((f) => isTestPath(f));
  const hasImpl = files.some((f) => !isTestPath(f) && !f.endsWith(".md") && !f.startsWith("docs/"));
  return hasTest && hasImpl;
}

async function resolveBase(
  tools: GateTools,
  baseRef: string,
  opts: ToolRunOpts,
): Promise<string | null> {
  const remote = `origin/${baseRef}`;
  if (await tools.git.refExists(remote, opts)) return remote;
  if (await tools.git.refExists(baseRef, opts)) return baseRef;
  return null;
}

function verdictToOutcome(verdict: TddVerdict): GateOutcome {
  const detail =
    verdict.violations.length > 0
      ? `${verdict.note}: ${verdict.violations.map((v) => `${v.reason}@${v.commit}`).join(", ")}`
      : `${verdict.note}${verdict.exempt ? " (exempt)" : ""}`;
  return ran("tdd", verdict.ok, detail);
}

export const tddStrategy: GateStrategy<GateTools> = {
  id: "tdd",
  async run(ctx: StrategyContext<GateTools>): Promise<GateOutcome> {
    const opts = { cwd: ctx.worktree };
    const base = await resolveBase(ctx.tools, ctx.baseRef, opts);
    if (base === null) {
      // base_ref_not_found — fail-closed (bin/pipeline-tdd-gate:34).
      return ran("tdd", false, `base_ref_not_found: origin/${ctx.baseRef} and ${ctx.baseRef}`);
    }

    // Tip-SHA memoization (Δ N): serve a prior classification of this tip without
    // re-running diff-tree. This is also the squashed-history no-op repeat: a second
    // invocation on the same squashed tip is served from memo, never re-classified.
    const tipSha = await ctx.tools.git.revParse("HEAD", opts);
    const memoized = ctx.memo?.getTdd(ctx.taskId, tipSha);
    if (memoized !== undefined) {
      return verdictToOutcome(memoized);
    }

    const commits = await ctx.tools.git.commits(base, ctx.taskId, opts);

    // Squash NO-OP: a single commit carrying both tests and impl is the squashed
    // shape — ordering is unverifiable, so the gate is a no-op (pass).
    if (isSquashedHistory(commits.map((c) => c.files))) {
      const verdict: TddVerdict = {
        ok: true,
        exempt: false,
        violations: [],
        note: "squashed history — TDD gate no-op",
      };
      ctx.memo?.putTdd(ctx.taskId, tipSha, verdict);
      return verdictToOutcome(verdict);
    }

    const exempt = ctx.exemptReader ? await ctx.exemptReader.isExempt(ctx.taskId) : false;
    const verdict = deriveTddVerdict(commits, exempt);
    ctx.memo?.putTdd(ctx.taskId, tipSha, verdict);
    return verdictToOutcome(verdict);
  },
};
