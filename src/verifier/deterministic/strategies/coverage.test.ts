/**
 * S8 — executable coverage gate vectors. Keeps the ported bin/pipeline-coverage-gate
 * math (per-metric 2dp delta, strict < -tolerance, offending metric named) and adds
 * the measure-on-miss flow: contract-derived command, per-tree-SHA store, fail-closed
 * on every non-measured answer naming which side broke.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig, type Config } from "../../../config/schema.js";
import { GATE_IDS } from "../gate-id.js";
import { GateContractSchema, type GateContract } from "../gate-contract.js";
import {
  FakeCoverageTool,
  FakeGitProbe,
  MemoryCoverageStore,
  makeFakeTools,
  measured,
  proc,
} from "../fakes.js";
import type { GateRan, GateSkip, StrategyContext } from "../strategy.js";
import type { CoverageMeasurement, CoverageSummary, GateTools } from "../tools.js";
import {
  COVERAGE_FLAGS,
  coverageDelta,
  coverageStrategy,
  regressions,
  resolveCoverageCommand,
  round2,
} from "./coverage.js";

const full: CoverageSummary = { lines: 90, branches: 90, functions: 90, statements: 90 };

/** A contract with every gate waived except test+coverage (both command-less). */
function contract(overrides: Partial<GateContract["gates"]> = {}): GateContract {
  const gates = Object.fromEntries(
    GATE_IDS.map((id) => [id, { contracted: false, reason: "test-waived" }]),
  ) as GateContract["gates"];
  return {
    version: 1,
    stack: "npm",
    gates: { ...gates, test: { contracted: true }, coverage: { contracted: true }, ...overrides },
  };
}

/** Git probe resolving origin/staging + both tree SHAs the strategy asks for. */
function covGit(): FakeGitProbe {
  return new FakeGitProbe({
    refs: {
      "origin/staging": "sha-base",
      "origin/staging^{tree}": "tree-base",
      HEAD: "sha-head",
    },
    treeSha: "tree-head",
  });
}

function covTool(head: CoverageMeasurement, base: CoverageMeasurement): FakeCoverageTool {
  return new FakeCoverageTool({ head, base });
}

function ctx(
  tools: GateTools,
  opts: {
    config?: Config;
    contract?: GateContract;
    store?: MemoryCoverageStore;
  } = {},
): StrategyContext<GateTools> {
  return {
    runId: "r",
    taskId: "t",
    worktree: "/wt",
    baseRef: "staging",
    config: opts.config ?? defaultConfig(),
    tools,
    contract: "contract" in opts ? opts.contract : contract(),
    coverageStore: opts.store,
  };
}

describe("coverage math", () => {
  it("round2 rounds to 2 decimal places", () => {
    expect(round2(1.234)).toBe(1.23);
    expect(round2(1.235)).toBe(1.24);
    // Tiny negatives round to (numeric) zero. jq's (x*100|round)/100 yields -0 too;
    // -0 === 0 and is never a regression, so assert numeric (not Object.is) equality.
    expect(round2(-0.001) === 0).toBe(true);
    expect(round2(89.999 - 90) === 0).toBe(true);
  });

  it("delta is after-before per metric", () => {
    const d = coverageDelta(full, { lines: 91, branches: 89, functions: 90, statements: 88 });
    expect(d).toEqual({ lines: 1, branches: -1, functions: 0, statements: -2 });
  });

  it("regressions are metrics below -tolerance (strict <)", () => {
    const d = { lines: -0.5, branches: -0.6, functions: 0, statements: -0.51 };
    // tolerance 0.5: -0.5 is NOT < -0.5 (boundary passes); -0.6 and -0.51 fail.
    expect(regressions(d, 0.5)).toEqual(["branches", "statements"]);
  });
});

describe("resolveCoverageCommand", () => {
  it("a gates.coverage.command override runs AS-IS (argv kind, no flags appended)", () => {
    const c = GateContractSchema.parse({
      version: 1,
      stack: "npm",
      gates: {
        ...contract().gates,
        coverage: { contracted: true, command: "npm run coverage:summary" },
      },
    });
    expect(resolveCoverageCommand(c)).toEqual({
      ok: true,
      cmd: { kind: "argv", argv: ["npm", "run", "coverage:summary"] },
    });
  });

  it("a contracted vitest test command reuses its tail + coverage flags", () => {
    const c = contract({ test: { contracted: true, command: "vitest run --config vt.ts" } });
    expect(resolveCoverageCommand(c)).toEqual({
      ok: true,
      cmd: { kind: "vitest", args: ["run", "--config", "vt.ts", ...COVERAGE_FLAGS] },
    });
  });

  it("a bare vitest test command gets the run subcommand forced (never watch mode)", () => {
    const c = contract({ test: { contracted: true, command: "vitest --config vt.ts" } });
    expect(resolveCoverageCommand(c)).toEqual({
      ok: true,
      cmd: { kind: "vitest", args: ["run", "--config", "vt.ts", ...COVERAGE_FLAGS] },
    });
  });

  it("a NON-vitest test command cannot be derived from — loud with the remedy", () => {
    const c = contract({ test: { contracted: true, command: "deno test" } });
    const r = resolveCoverageCommand(c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("deno test");
      expect(r.reason).toContain("gates.coverage.command");
    }
  });

  it("no test override → the built-in vitest run + flags", () => {
    expect(resolveCoverageCommand(contract())).toEqual({
      ok: true,
      cmd: { kind: "vitest", args: ["run", ...COVERAGE_FLAGS] },
    });
  });
});

describe("coverageStrategy — measure-on-miss over the store", () => {
  it("measures head in the worktree + base at the base sha, PASSES within tolerance, fills the store", async () => {
    const tool = covTool(measured(full), measured(full));
    const store = new MemoryCoverageStore();
    const out = await coverageStrategy.run(
      ctx(makeFakeTools({ git: covGit(), coverage: tool }), { store }),
    );
    expect((out as GateRan).evidence.observed).toBe(true);
    expect(tool.measureCalls).toEqual([
      { cwd: "/wt", cmd: { kind: "vitest", args: ["run", ...COVERAGE_FLAGS] } },
    ]);
    expect(tool.baseCalls).toEqual([
      { baseSha: "sha-base", cmd: { kind: "vitest", args: ["run", ...COVERAGE_FLAGS] } },
    ]);
    expect(store.entries.get("tree-head")).toEqual(full);
    expect(store.entries.get("tree-base")).toEqual(full);
  });

  it("any metric decreased beyond tolerance → FAIL naming the metric", async () => {
    const tool = covTool(
      measured({ lines: 90, branches: 88, functions: 90, statements: 90 }),
      measured(full),
    );
    const out = await coverageStrategy.run(ctx(makeFakeTools({ git: covGit(), coverage: tool })));
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("branches");
  });

  it("boundary -0.5 at tolerance 0.5 passes (strict <)", async () => {
    const tool = covTool(
      measured({ lines: 89.5, branches: 90, functions: 90, statements: 90 }),
      measured(full),
    );
    const out = await coverageStrategy.run(ctx(makeFakeTools({ git: covGit(), coverage: tool })));
    expect((out as GateRan).evidence.observed).toBe(true);
  });

  it("config tolerance drives the threshold (no scattered literal)", async () => {
    const config = defaultConfig();
    config.quality.coverageRegressionTolerancePct = 5;
    const tool = covTool(
      measured({ lines: 86, branches: 90, functions: 90, statements: 90 }), // -4, within 5
      measured(full),
    );
    const out = await coverageStrategy.run(
      ctx(makeFakeTools({ git: covGit(), coverage: tool }), { config }),
    );
    expect((out as GateRan).evidence.observed).toBe(true);
  });

  it("store hits on BOTH trees ⇒ the tool is never invoked", async () => {
    const tool = covTool(measured(full), measured(full));
    const store = new MemoryCoverageStore();
    store.entries.set("tree-head", full);
    store.entries.set("tree-base", full);
    const out = await coverageStrategy.run(
      ctx(makeFakeTools({ git: covGit(), coverage: tool }), { store }),
    );
    expect((out as GateRan).evidence.observed).toBe(true);
    expect(tool.measureCalls).toHaveLength(0);
    expect(tool.baseCalls).toHaveLength(0);
  });

  it("no store at all ⇒ measures uncached (the store is perf-only, never correctness)", async () => {
    const tool = covTool(measured(full), measured(full));
    const out = await coverageStrategy.run(ctx(makeFakeTools({ git: covGit(), coverage: tool })));
    expect((out as GateRan).evidence.observed).toBe(true);
    expect(tool.measureCalls).toHaveLength(1);
    expect(tool.baseCalls).toHaveLength(1);
  });

  it("HEAD command failure → fail-closed naming head + the stderr excerpt", async () => {
    const tool = covTool(
      { kind: "command-failed", proc: proc(1, "", "3 tests failed") },
      measured(full),
    );
    const out = await coverageStrategy.run(ctx(makeFakeTools({ git: covGit(), coverage: tool })));
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("coverage measurement (head)");
    expect(ev.detail).toContain("3 tests failed");
  });

  it("BASE command failure → fail-closed naming the base sha + the deps remedy", async () => {
    const tool = covTool(measured(full), { kind: "command-failed", proc: proc(2, "", "boom") });
    const out = await coverageStrategy.run(ctx(makeFakeTools({ git: covGit(), coverage: tool })));
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("base sha-base");
    expect(ev.detail).toContain("node_modules");
  });

  it("summary-missing → fail-closed (exit 0 without a summary is never a pass)", async () => {
    const tool = covTool({ kind: "summary-missing" }, measured(full));
    const out = await coverageStrategy.run(ctx(makeFakeTools({ git: covGit(), coverage: tool })));
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("wrote no coverage/coverage-summary.json");
  });

  it("summary-invalid → fail-closed (corrupt ≠ absent)", async () => {
    const tool = covTool({ kind: "summary-invalid" }, measured(full));
    const out = await coverageStrategy.run(ctx(makeFakeTools({ git: covGit(), coverage: tool })));
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("invalid");
  });

  it("a failed measurement is NOT stored (only measured summaries are cached)", async () => {
    const tool = covTool({ kind: "summary-missing" }, measured(full));
    const store = new MemoryCoverageStore();
    await coverageStrategy.run(ctx(makeFakeTools({ git: covGit(), coverage: tool }), { store }));
    expect(store.entries.size).toBe(0);
  });

  it("unresolvable base ref → fail-closed base_ref_not_found", async () => {
    const git = new FakeGitProbe({ refs: { HEAD: "sha-head" }, treeSha: "tree-head" });
    const out = await coverageStrategy.run(
      ctx(makeFakeTools({ git, coverage: covTool(measured(full), measured(full)) })),
    );
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("base_ref_not_found");
  });

  it("no gate contract (legacy pre-contract worktree) → skip no-gate-contract", async () => {
    const tool = covTool(measured(full), measured(full));
    const out = await coverageStrategy.run(
      ctx(makeFakeTools({ git: covGit(), coverage: tool }), { contract: undefined }),
    );
    expect(out.kind).toBe("skip");
    expect((out as GateSkip).reason).toBe("no-gate-contract");
    expect(tool.measureCalls).toHaveLength(0);
  });

  it("a NON-vitest contracted test command → cannot-derive FAIL (never a silent skip)", async () => {
    const tool = covTool(measured(full), measured(full));
    const out = await coverageStrategy.run(
      ctx(makeFakeTools({ git: covGit(), coverage: tool }), {
        contract: contract({ test: { contracted: true, command: "go test" } }),
      }),
    );
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("cannot derive");
    expect(tool.measureCalls).toHaveLength(0);
  });

  it("a coverage command override is executed as-is on both sides (argv kind)", async () => {
    const tool = covTool(measured(full), measured(full));
    const out = await coverageStrategy.run(
      ctx(makeFakeTools({ git: covGit(), coverage: tool }), {
        contract: contract({
          coverage: { contracted: true, command: "npm run coverage:summary" },
        }),
      }),
    );
    expect((out as GateRan).evidence.observed).toBe(true);
    const argv = { kind: "argv", argv: ["npm", "run", "coverage:summary"] };
    expect(tool.measureCalls).toEqual([{ cwd: "/wt", cmd: argv }]);
    expect(tool.baseCalls).toEqual([{ baseSha: "sha-base", cmd: argv }]);
  });
});
