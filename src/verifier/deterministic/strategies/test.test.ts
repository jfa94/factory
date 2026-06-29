/**
 * WS6 — test-gate strategy vectors.
 *
 * Key regression: a diff-scoped set of ONLY non-vitest test files (e.g. pure pgTAP
 * under supabase/tests/) must pass vacuously — vitest is never invoked on them, and
 * their green-ness is delegated to the reviewer panel + the target repo's CI.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig, type Config } from "../../../config/schema.js";
import { FakeGitProbe, FakeVitest, makeFakeTools, proc } from "../fakes.js";
import type { GateRan, StrategyContext } from "../strategy.js";
import type { GateTools } from "../tools.js";
import { testStrategy } from "./test.js";

function ctx(tools: GateTools, config: Config = defaultConfig()): StrategyContext<GateTools> {
  return { runId: "r", taskId: "t", worktree: "/wt", baseRef: "staging", config, tools };
}

function probe(changed: readonly string[]) {
  return new FakeGitProbe({ refs: { "origin/staging": "sha-base" }, changedFiles: changed });
}

describe("testStrategy — non-vitest test files (pgTAP regression)", () => {
  it("pure pgTAP diff → vacuous pass, vitest NOT invoked on the .sql", async () => {
    const fakeVitest = new FakeVitest(proc(1)); // would fail if called
    const tools = makeFakeTools({ git: probe(["supabase/tests/x.test.sql"]), vitest: fakeVitest });
    const out = await testStrategy.run(ctx(tools));
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(true);
    expect(ev.detail).toContain("not executed");
    // Prove vitest was never handed the .sql — if it were, proc(1) would have caused a fail
    expect(fakeVitest.calls.every((c) => !c.files?.some((f) => f.endsWith(".sql")))).toBe(true);
  });

  it("multiple non-vitest files only → vacuous pass", async () => {
    const fakeVitest = new FakeVitest(proc(1));
    const tools = makeFakeTools({
      git: probe(["supabase/tests/a.test.sql", "pkg/foo_test.go"]),
      vitest: fakeVitest,
    });
    const out = await testStrategy.run(ctx(tools));
    expect((out as GateRan).evidence.observed).toBe(true);
  });
});

describe("testStrategy — vitest test files", () => {
  it("passing .test.ts → observed true", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.test.ts"]),
      vitest: new FakeVitest(proc(0)),
    });
    const out = await testStrategy.run(ctx(tools));
    expect((out as GateRan).evidence.observed).toBe(true);
  });

  it("failing .test.ts → observed false", async () => {
    const tools = makeFakeTools({
      git: probe(["src/foo.test.ts"]),
      vitest: new FakeVitest(proc(1)),
    });
    const out = await testStrategy.run(ctx(tools));
    expect((out as GateRan).evidence.observed).toBe(false);
  });

  it("no changed test files → full un-scoped run (vitest called with [])", async () => {
    const fakeVitest = new FakeVitest(proc(0));
    const tools = makeFakeTools({ git: probe(["src/foo.ts"]), vitest: fakeVitest });
    await testStrategy.run(ctx(tools));
    expect(fakeVitest.calls).toHaveLength(1);
    expect(fakeVitest.calls[0]!.files).toEqual([]);
  });
});
