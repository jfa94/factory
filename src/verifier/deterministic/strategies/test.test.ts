/**
 * WS6 — test-gate strategy vectors.
 *
 * Key regressions:
 *  - A diff-scoped set of ONLY non-vitest test files (e.g. pure pgTAP, .d.ts)
 *    must SKIP — "nothing ran" must never read as "passed".
 *  - A mixed diff (vitest + non-vitest) must run only the vitest-runnable subset
 *    and surface the excluded count in the evidence detail.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig, type Config } from "../../../config/schema.js";
import { FakeGitProbe, FakeVitest, makeFakeTools, proc } from "../fakes.js";
import type { GateRan, GateSkip, StrategyContext } from "../strategy.js";
import type { GateTools } from "../tools.js";
import { isVitestRunnable, testStrategy } from "./test.js";

function ctx(tools: GateTools, config: Config = defaultConfig()): StrategyContext<GateTools> {
  return { runId: "r", taskId: "t", worktree: "/wt", baseRef: "staging", config, tools };
}

function probe(changed: readonly string[]) {
  return new FakeGitProbe({ refs: { "origin/staging": "sha-base" }, changedFiles: changed });
}

describe("testStrategy — non-vitest test files (pgTAP regression)", () => {
  it("pure pgTAP diff → skip, vitest NOT invoked", async () => {
    const fakeVitest = new FakeVitest(proc(1)); // would fail if called
    const tools = makeFakeTools({ git: probe(["supabase/tests/x.test.sql"]), vitest: fakeVitest });
    const out = await testStrategy.run(ctx(tools));
    expect(out.kind).toBe("skip");
    expect((out as GateSkip).reason).toBe("no-vitest-runnable-tests-in-scope");
    expect(fakeVitest.calls).toHaveLength(0);
  });

  it("multiple non-vitest files only → skip", async () => {
    const fakeVitest = new FakeVitest(proc(1));
    const tools = makeFakeTools({
      git: probe(["supabase/tests/a.test.sql", "pkg/foo_test.go"]),
      vitest: fakeVitest,
    });
    const out = await testStrategy.run(ctx(tools));
    expect(out.kind).toBe("skip");
    expect(fakeVitest.calls).toHaveLength(0);
  });

  it(".d.ts declaration file in tests/ → skip (not handed to vitest)", async () => {
    const fakeVitest = new FakeVitest(proc(1));
    const tools = makeFakeTools({
      git: probe(["tests/globals.d.ts"]),
      vitest: fakeVitest,
    });
    const out = await testStrategy.run(ctx(tools));
    expect(out.kind).toBe("skip");
    expect(fakeVitest.calls).toHaveLength(0);
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

  it("mixed diff (sql + ts) → vitest gets only the .ts, detail names excluded count", async () => {
    const fakeVitest = new FakeVitest(proc(0));
    const tools = makeFakeTools({
      git: probe(["supabase/tests/a.test.sql", "src/foo.test.ts"]),
      vitest: fakeVitest,
    });
    const out = await testStrategy.run(ctx(tools));
    expect(out.kind).toBe("ran");
    const ev = (out as GateRan).evidence;
    expect(ev.observed).toBe(true);
    // vitest received only the TS file
    expect(fakeVitest.calls[0]!.files).toEqual(["src/foo.test.ts"]);
    // audit trail names the excluded non-vitest file
    expect(ev.detail).toContain("1 non-vitest file(s) not executed");
  });
});

describe("isVitestRunnable extension matrix", () => {
  it("returns true for JS/TS extensions vitest can execute", () => {
    const runnable = [
      "src/foo.test.ts",
      "src/foo.spec.tsx",
      "tests/bar.js",
      "tests/baz.mjs",
      "src/foo.cjs",
      "src/foo.jsx",
    ];
    for (const p of runnable) expect(isVitestRunnable(p), p).toBe(true);
  });

  it("returns false for non-JS test files vitest cannot execute", () => {
    const notRunnable = [
      "supabase/tests/x.test.sql",
      "pkg/foo_test.go",
      "src/FooTest.java",
      "tests/foo_test.py",
      "spec/foo_spec.rb",
    ];
    for (const p of notRunnable) expect(isVitestRunnable(p), p).toBe(false);
  });

  it("returns false for .d.ts declaration files (.ts$ matches but excluded)", () => {
    expect(isVitestRunnable("tests/globals.d.ts")).toBe(false);
    expect(isVitestRunnable("src/types/foo.d.ts")).toBe(false);
  });
});
