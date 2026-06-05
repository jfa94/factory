/**
 * WS6 — GateRunner acceptance (D26 / Δ V derive-don't-store).
 *
 * Asserts the load-bearing invariants:
 *  - the verdict is DERIVED via deriveAllGatesVerdict over evidence, with no API to
 *    inject a stored "pass" (one failing gate ⇒ overall fail; all pass ⇒ pass);
 *  - an all-skipped / empty-evidence sweep FAILS closed (never default-open);
 *  - a strategy throw (truncated tool output) PROPAGATES — never swallowed to a pass;
 *  - ONE config drives every threshold (changing QualitySchema flips the verdict
 *    with the SAME tool outputs);
 *  - strategyFor is exhaustive over the closed GateId union.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/schema.js";
import { GATE_IDS } from "./strategy.js";
import {
  FakeCoverageReader,
  FakeEslint,
  FakeGitProbe,
  FakeStryker,
  FakeVitest,
  makeFakeTools,
  proc,
  strykerResult,
} from "./fakes.js";
import { GateRunner, strategyFor, type GateContext } from "./gate-runner.js";
import { GateMemo } from "./memo.js";
import type { CoverageSummary, GateTools } from "./tools.js";

const full: CoverageSummary = { lines: 100, branches: 100, functions: 100, statements: 100 };

/** A git probe with origin/staging present, no changed files, a HEAD sha, no commits. */
function greenGit(extra: Record<string, string> = {}): FakeGitProbe {
  return new FakeGitProbe({
    refs: { "origin/staging": "sha-base", HEAD: "sha-head", ...extra },
    changedFiles: [],
    commits: [],
  });
}

function baseCtx(tools: GateTools, gates: readonly (typeof GATE_IDS)[number][]): GateContext {
  return {
    runId: "r1",
    taskId: "t1",
    worktree: "/wt",
    baseRef: "staging",
    config: defaultConfig(),
    tools,
    gates,
    exemptReader: { isExempt: async () => false },
  };
}

describe("strategyFor (closed union, exhaustive)", () => {
  it("resolves a strategy for every GATE_ID", () => {
    for (const id of GATE_IDS) {
      expect(strategyFor(id).id).toBe(id);
    }
  });

  it("throws (assertNever) on an unknown gate id", () => {
    // Bypass the type system to prove the runtime fail-loud branch exists.
    expect(() => strategyFor("bogus" as (typeof GATE_IDS)[number])).toThrow();
  });
});

describe("GateRunner — Δ V derive-don't-store conjunction", () => {
  it("all gates pass ⇒ DERIVED verdict passes, marked __derived", async () => {
    // test+tdd+type+lint+build only (coverage/mutation/sast need richer setup;
    // exercised in their own suites). All green tools ⇒ all observed:true.
    const tools = makeFakeTools({ git: greenGit() });
    const res = await new GateRunner().run(baseCtx(tools, ["test", "type", "lint", "build"]));
    expect(res.verdict.passed).toBe(true);
    expect(res.verdict.__derived).toBe(true);
    expect(res.evidence.every((e) => e.observed)).toBe(true);
  });

  it("ONE failing gate flips the conjunctive verdict to fail", async () => {
    const tools = makeFakeTools({ git: greenGit(), eslint: new FakeEslint(proc(1)) });
    const res = await new GateRunner().run(baseCtx(tools, ["test", "type", "lint", "build"]));
    expect(res.verdict.passed).toBe(false);
  });

  it("empty evidence (all gates skipped) FAILS closed — never default-open", async () => {
    // sast with no securityCommand skips; run ONLY sast ⇒ zero evidence.
    const tools = makeFakeTools({ git: greenGit() });
    const res = await new GateRunner().run(baseCtx(tools, ["sast"]));
    expect(res.evidence).toHaveLength(0);
    expect(res.skipped).toHaveLength(1);
    expect(res.verdict.passed).toBe(false); // deriveAllGatesVerdict([]) === false
  });

  it("a stored 'pass' cannot bypass re-derivation — verdict is computed each run", async () => {
    // Same tools, two runs: identical DERIVED verdicts, both carry __derived:true
    // (no field on the result lets a caller pre-seed a verdict).
    const tools = makeFakeTools({ git: greenGit() });
    const runner = new GateRunner();
    const a = await runner.run(baseCtx(tools, ["test"]));
    const b = await runner.run(baseCtx(tools, ["test"]));
    expect(a.verdict.__derived).toBe(true);
    expect(b.verdict.__derived).toBe(true);
    expect(a.verdict.passed).toBe(b.verdict.passed);
  });
});

describe("GateRunner — tree-SHA evidence memo (Δ O)", () => {
  it("serves an identical-content re-run from the memo (tool NOT re-invoked)", async () => {
    const memo = new GateMemo();
    const vitest = new FakeVitest(proc(0));
    const git = new FakeGitProbe({
      refs: { "origin/staging": "sha-base", HEAD: "sha-head" },
      changedFiles: [],
      commits: [],
      treeSha: "tree-A",
    });
    const tools = makeFakeTools({ git, vitest });
    const ctx: GateContext = { ...baseCtx(tools, ["test"]), memo };

    const a = await new GateRunner().run(ctx);
    const b = await new GateRunner().run(ctx);

    expect(a.verdict.passed).toBe(true);
    expect(b.verdict.passed).toBe(true);
    // Same tree SHA + shared memo ⇒ the vitest tool ran ONCE; the second sweep was
    // served from the evidence memo (the Δ O acceptance criterion).
    expect(vitest.calls).toHaveLength(1);
  });

  it("re-runs the tool when the tree SHA changes (different content ⇒ memo miss)", async () => {
    const memo = new GateMemo();
    const vitest = new FakeVitest(proc(0));
    const ctxFor = (tree: string): GateContext => ({
      ...baseCtx(
        makeFakeTools({
          git: new FakeGitProbe({
            refs: { "origin/staging": "sha-base", HEAD: "sha-head" },
            changedFiles: [],
            commits: [],
            treeSha: tree,
          }),
          vitest,
        }),
        ["test"],
      ),
      memo,
    });

    await new GateRunner().run(ctxFor("tree-1"));
    await new GateRunner().run(ctxFor("tree-2"));

    // Distinct tree SHAs ⇒ no memo hit ⇒ the tool is invoked each run.
    expect(vitest.calls).toHaveLength(2);
  });
});

describe("GateRunner — fail-loud on truncation (never swallow to a pass)", () => {
  it("a truncated tool output throws OUT of the runner", async () => {
    const tools = makeFakeTools({
      git: greenGit(),
      vitest: new FakeVitest(proc(0, "", "", true)),
    });
    await expect(new GateRunner().run(baseCtx(tools, ["test"]))).rejects.toThrow(/truncated/i);
  });
});

describe("GateRunner — ONE config drives every gate (Δ V)", () => {
  it("same tool outputs, different mutationScoreTarget ⇒ different verdict", async () => {
    const mkTools = (): GateTools =>
      makeFakeTools({
        git: new FakeGitProbe({
          refs: { "origin/staging": "sha-base", HEAD: "sha-head" },
          changedFiles: ["src/foo.ts"],
        }),
        stryker: new FakeStryker(strykerResult({ code: 0, score: 75 })),
      });

    const strict = defaultConfig();
    strict.quality.mutationScoreTarget = 80; // 75 < 80 → fail
    const lax = defaultConfig();
    lax.quality.mutationScoreTarget = 70; // 75 >= 70 → pass

    const runStrict = await new GateRunner().run({
      runId: "r",
      taskId: "t",
      worktree: "/wt",
      baseRef: "staging",
      config: strict,
      tools: mkTools(),
      gates: ["mutation"],
    });
    const runLax = await new GateRunner().run({
      runId: "r",
      taskId: "t",
      worktree: "/wt",
      baseRef: "staging",
      config: lax,
      tools: mkTools(),
      gates: ["mutation"],
    });

    expect(runStrict.verdict.passed).toBe(false);
    expect(runLax.verdict.passed).toBe(true);
  });

  it("coverage tolerance from config flips the verdict on identical readings", async () => {
    const mkTools = (): GateTools =>
      makeFakeTools({
        git: greenGit(),
        coverage: new FakeCoverageReader({
          before: full,
          after: { lines: 97, branches: 100, functions: 100, statements: 100 }, // -3
        }),
      });
    const strict = defaultConfig();
    strict.quality.coverageRegressionTolerancePct = 0.5; // -3 < -0.5 → fail
    const lax = defaultConfig();
    lax.quality.coverageRegressionTolerancePct = 5; // -3 within 5 → pass

    const s = await new GateRunner().run({
      runId: "r",
      taskId: "t",
      worktree: "/wt",
      baseRef: "staging",
      config: strict,
      tools: mkTools(),
      gates: ["coverage"],
    });
    const l = await new GateRunner().run({
      runId: "r",
      taskId: "t",
      worktree: "/wt",
      baseRef: "staging",
      config: lax,
      tools: mkTools(),
      gates: ["coverage"],
    });
    expect(s.verdict.passed).toBe(false);
    expect(l.verdict.passed).toBe(true);
  });
});
