/**
 * WS6 — mutation gate vectors (Δ O). Ports mutation-gate.sh score boundaries
 * (T4b/T4b2/T4b3/T4b4/T4c), fail-closed reasons (T4a/T4d/A2), scope skip
 * (T3a/T3b), and base-missing. The strict-float scorePasses is the T8 oracle.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig, type Config } from "../../../config/schema.js";
import { FakeFs, FakeGitProbe, FakeStryker, makeFakeTools, strykerResult } from "../fakes.js";
import type { GateRan, GateSkip, StrategyContext } from "../strategy.js";
import type { GateTools } from "../tools.js";
import { mutationStrategy, scorePasses } from "./mutation.js";

function ctx(tools: GateTools, config: Config = defaultConfig()): StrategyContext<GateTools> {
  return { runId: "r", taskId: "t", worktree: "/wt", baseRef: "staging", config, tools };
}

/** A git probe with origin/staging present + the given changed files. */
function probe(changed: readonly string[]) {
  return new FakeGitProbe({ refs: { "origin/staging": "sha-base" }, changedFiles: changed });
}

describe("scorePasses (T8 strict float — the boundary oracle)", () => {
  it("79.5 vs 80 → fail; 79.999 vs 80 → fail; 80.0 vs 80 → pass; 85 → pass", () => {
    expect(scorePasses(79.5, 80)).toBe(false);
    expect(scorePasses(79.999, 80)).toBe(false);
    expect(scorePasses(80.0, 80)).toBe(true);
    expect(scorePasses(85, 80)).toBe(true);
  });
});

describe("mutationStrategy (Δ O)", () => {
  it("T3a/T3b: empty mutable scope → SKIP no-mutable-changes", async () => {
    const tools = makeFakeTools({ git: probe(["docs/x.md", "src/foo.test.ts"]) });
    const out = await mutationStrategy.run(ctx(tools));
    expect(out.kind).toBe("skip");
    expect((out as GateSkip).reason).toBe("no-mutable-changes");
  });

  it("no stryker binary in the worktree → SKIP no-mutation-binary (not applicable)", async () => {
    const tools = makeFakeTools({ git: probe(["src/foo.ts"]), fs: new FakeFs([]) });
    const out = await mutationStrategy.run(ctx(tools));
    expect(out.kind).toBe("skip");
    expect((out as GateSkip).reason).toBe("no-mutation-binary");
  });

  it("stryker binary present but NO config → SKIP no-mutation-config", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      fs: new FakeFs(["node_modules/.bin/stryker"]),
    });
    const out = await mutationStrategy.run(ctx(tools));
    expect(out.kind).toBe("skip");
    expect((out as GateSkip).reason).toBe("no-mutation-config");
  });

  it("base-missing → fail-closed", async () => {
    const tools = makeFakeTools({
      git: new FakeGitProbe({ refs: {}, changedFiles: ["src/a.ts"] }),
    });
    const out = await mutationStrategy.run(ctx(tools));
    expect(out.kind).toBe("ran");
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("base-missing");
  });

  it("T4b2: 79.5 vs target 80 → fail score-below-target", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      stryker: new FakeStryker(strykerResult({ code: 0, score: 79.5 })),
    });
    const out = await mutationStrategy.run(ctx(tools));
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("score-below-target");
  });

  it("T4b3: 80.0 vs target 80 → pass", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      stryker: new FakeStryker(strykerResult({ code: 0, score: 80.0 })),
    });
    const out = await mutationStrategy.run(ctx(tools));
    expect((out as GateRan).evidence.observed).toBe(true);
  });

  it("T4c: 85 vs target 80 → pass", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      stryker: new FakeStryker(strykerResult({ code: 0, score: 85 })),
    });
    const out = await mutationStrategy.run(ctx(tools));
    expect((out as GateRan).evidence.observed).toBe(true);
  });

  it("T4b: 42 vs target 60 (config-driven) → fail", async () => {
    const config = defaultConfig();
    config.quality.mutationScoreTarget = 60;
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      stryker: new FakeStryker(strykerResult({ code: 0, score: 42 })),
    });
    const out = await mutationStrategy.run(ctx(tools, config));
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("42 < 60");
  });

  it("T4a: stryker non-zero → stryker-failed (fail-closed)", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      stryker: new FakeStryker(strykerResult({ code: 7 })),
    });
    const out = await mutationStrategy.run(ctx(tools));
    expect((out as GateRan).evidence.detail).toContain("stryker-failed");
  });

  it("T4d: green but no report (non-empty scope) → no-report (fail-closed)", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      stryker: new FakeStryker(strykerResult({ code: 0, reportPresent: false })),
    });
    const out = await mutationStrategy.run(ctx(tools));
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("no-report");
  });

  it("A2: report present but no score → no-score (fail-closed)", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      stryker: new FakeStryker(strykerResult({ code: 0, score: null, reportPresent: true })),
    });
    const out = await mutationStrategy.run(ctx(tools));
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("no-score");
  });

  it("truncated stryker payload → THROWS (never mis-parse a clipped report)", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      stryker: new FakeStryker(strykerResult({ code: 0, score: 90, truncated: true })),
    });
    await expect(mutationStrategy.run(ctx(tools))).rejects.toThrow(/truncated/i);
  });
});

describe("mutationStrategy — derivable score is authoritative over exit code", () => {
  // Target repos gate CI via stryker's `break: N` exit code, so a stryker run that
  // meets the FACTORY's mutationScoreTarget can still exit non-zero (CI's bar differs).
  // A present, derivable score must win over that exit — only a NO-score report lets
  // the non-zero exit decide (a crash before scoring).
  it("non-zero exit + present passing score → pass (break must not mask a passing score)", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      stryker: new FakeStryker(strykerResult({ code: 1, score: 94, reportPresent: true })),
    });
    const out = await mutationStrategy.run(ctx(tools));
    expect((out as GateRan).evidence.observed).toBe(true);
    expect((out as GateRan).evidence.detail).toContain("94");
  });

  it("non-zero exit + present failing score → score-below-target (not stryker-failed)", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      stryker: new FakeStryker(strykerResult({ code: 1, score: 50, reportPresent: true })),
    });
    const out = await mutationStrategy.run(ctx(tools));
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(false);
    expect(ev.detail).toContain("score-below-target");
  });

  it("non-zero exit + absent report → stryker-failed (no score to trust)", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      stryker: new FakeStryker(strykerResult({ code: 7, reportPresent: false })),
    });
    const out = await mutationStrategy.run(ctx(tools));
    expect((out as GateRan).evidence.detail).toContain("stryker-failed");
  });

  it("non-zero exit + unparseable report → stryker-failed", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      stryker: new FakeStryker(strykerResult({ code: 1, unparseable: true })),
    });
    const out = await mutationStrategy.run(ctx(tools));
    expect((out as GateRan).evidence.detail).toContain("stryker-failed");
  });

  it("non-zero exit + present but score-less report → stryker-failed (exit decides)", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.ts"]),
      stryker: new FakeStryker(strykerResult({ code: 1, score: null, reportPresent: true })),
    });
    const out = await mutationStrategy.run(ctx(tools));
    expect((out as GateRan).evidence.detail).toContain("stryker-failed");
  });
});
