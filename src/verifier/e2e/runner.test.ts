/**
 * E2E runner unit vectors (Decision 39).
 *
 *  - parseE2eReport: flattens (possibly nested) suites, classifies each spec off
 *    Playwright's own retry-reconciled `tests[].status`, derives counts + `ok`.
 *  - runE2e: the orchestration wrapper — truncation guard, empty-output guard,
 *    otherwise delegates to parseE2eReport.
 *  - resolveLocalPlaywrightBin / DefaultPlaywrightTool: never-npx local-bin
 *    resolution, mirroring deterministic/tools.ts's resolveLocalBin coverage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../shared/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/index.js")>();
  return { ...actual, exec: vi.fn() };
});

import { exec, type ExecResult } from "../../shared/index.js";
import {
  DefaultPlaywrightTool,
  parseE2eReport,
  resolveLocalPlaywrightBin,
  runE2e,
  type E2eProcResult,
  type LocalPlaywrightResolver,
  type PlaywrightTool,
} from "./runner.js";

const execMock = vi.mocked(exec);

function res(stdout: string, code = 0, truncated = false): ExecResult {
  return { stdout, stderr: "", code, signal: null, truncated };
}

function pwJson(suites: unknown[]): string {
  return JSON.stringify({ suites });
}

describe("parseE2eReport", () => {
  it("classifies passed/failed/flaky/skipped specs and derives counts + ok", () => {
    const report = pwJson([
      {
        specs: [
          {
            title: "checkout works",
            file: "e2e/checkout.spec.ts",
            tests: [{ status: "expected" }],
          },
          { title: "login works", file: "e2e/login.spec.ts", tests: [{ status: "unexpected" }] },
          { title: "search is slow", file: "e2e/search.spec.ts", tests: [{ status: "flaky" }] },
          { title: "old flow", file: "e2e/old.spec.ts", tests: [{ status: "skipped" }] },
        ],
      },
    ]);
    const result = parseE2eReport(report);
    expect(result.specs).toEqual([
      { file: "e2e/checkout.spec.ts", title: "checkout works", status: "passed" },
      { file: "e2e/login.spec.ts", title: "login works", status: "failed" },
      { file: "e2e/search.spec.ts", title: "search is slow", status: "flaky" },
      { file: "e2e/old.spec.ts", title: "old flow", status: "skipped" },
    ]);
    expect(result.counts).toEqual({ passed: 1, failed: 1, flaky: 1, skipped: 1 });
    expect(result.ok).toBe(false); // one failed spec
  });

  it("ok is true when there are zero failed specs (flaky/skipped never block)", () => {
    const report = pwJson([
      {
        specs: [
          { title: "a", file: "e2e/a.spec.ts", tests: [{ status: "expected" }] },
          { title: "b", file: "e2e/b.spec.ts", tests: [{ status: "flaky" }] },
          { title: "c", file: "e2e/c.spec.ts", tests: [{ status: "skipped" }] },
        ],
      },
    ]);
    expect(parseE2eReport(report).ok).toBe(true);
  });

  it("flattens nested describe-block suites", () => {
    const report = pwJson([
      {
        suites: [
          {
            specs: [
              { title: "nested", file: "e2e/nested.spec.ts", tests: [{ status: "expected" }] },
            ],
            suites: [
              {
                specs: [
                  { title: "deep", file: "e2e/deep.spec.ts", tests: [{ status: "unexpected" }] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const result = parseE2eReport(report);
    expect(result.specs.map((s) => s.title)).toEqual(["nested", "deep"]);
    expect(result.counts).toEqual({ passed: 1, failed: 1, flaky: 0, skipped: 0 });
  });

  it("a multi-project spec is FAILED if any project's test is unexpected", () => {
    const report = pwJson([
      {
        specs: [
          {
            title: "cross-browser",
            file: "e2e/x.spec.ts",
            tests: [{ status: "expected" }, { status: "unexpected" }],
          },
        ],
      },
    ]);
    expect(parseE2eReport(report).specs[0]?.status).toBe("failed");
  });

  it("throws with a clear message on unparseable JSON", () => {
    expect(() => parseE2eReport("not json")).toThrow(/could not parse/i);
  });

  it("ok is false when the process exited nonzero even though zero specs are marked failed", () => {
    const report = pwJson([
      { specs: [{ title: "a", file: "e2e/a.spec.ts", tests: [{ status: "expected" }] }] },
    ]);
    // The silent-pass bug: a crashed/errored run (bad boot, no tests matched) can still
    // report a clean zero-failed suite — the exit code is what actually tells us it errored.
    expect(parseE2eReport(report, 1).ok).toBe(false);
  });

  it("ok is true by default (code omitted) when zero specs are marked failed — back-compat", () => {
    const report = pwJson([
      { specs: [{ title: "a", file: "e2e/a.spec.ts", tests: [{ status: "expected" }] }] },
    ]);
    expect(parseE2eReport(report).ok).toBe(true);
  });

  it("ok is false when the reporter's top-level errors[] is non-empty, even with zero failed specs", () => {
    const report = JSON.stringify({
      suites: [{ specs: [{ title: "a", file: "e2e/a.spec.ts", tests: [{ status: "expected" }] }] }],
      errors: [{ message: "Error: could not connect to http://localhost:3000" }],
    });
    expect(parseE2eReport(report, 0).ok).toBe(false);
  });
});

describe("runE2e", () => {
  const okTool = (json: string): PlaywrightTool => ({
    run: async () => ({ code: 0, stdout: json, stderr: "", truncated: false }),
  });

  it("delegates to parseE2eReport on a normal (possibly red) run", async () => {
    const report = pwJson([
      { specs: [{ title: "a", file: "e2e/a.spec.ts", tests: [{ status: "unexpected" }] }] },
    ]);
    const result = await runE2e({ cwd: "/wt" }, okTool(report));
    expect(result.ok).toBe(false);
    expect(result.counts.failed).toBe(1);
  });

  it("ok is false end-to-end when the tool exits nonzero despite a clean (0-failed) report", async () => {
    const report = pwJson([
      { specs: [{ title: "a", file: "e2e/a.spec.ts", tests: [{ status: "expected" }] }] },
    ]);
    const tool: PlaywrightTool = {
      run: async () => ({ code: 1, stdout: report, stderr: "boot failed", truncated: false }),
    };
    const result = await runE2e({ cwd: "/wt" }, tool);
    expect(result.ok).toBe(false);
    expect(result.counts.failed).toBe(0); // the silent-pass bug: no spec is individually failed
  });

  it("throws on a truncated payload rather than parsing a clipped JSON blob", async () => {
    const tool: PlaywrightTool = {
      run: async () => ({ code: 0, stdout: "{", stderr: "", truncated: true }),
    };
    await expect(runE2e({ cwd: "/wt" }, tool)).rejects.toThrow(/truncated/i);
  });

  it("throws when the tool produced no output at all (missing bin, crashed boot)", async () => {
    const tool: PlaywrightTool = {
      run: async () => ({
        code: 127,
        stdout: "",
        stderr: "playwright: command not found",
        truncated: false,
      }),
    };
    await expect(runE2e({ cwd: "/wt" }, tool)).rejects.toThrow(/no output/i);
  });
});

describe("resolveLocalPlaywrightBin (walk-up node_modules/.bin)", () => {
  const existsIn = (paths: readonly string[]): ((p: string) => Promise<boolean>) => {
    const set = new Set(paths);
    return async (p: string) => set.has(p);
  };

  it("resolves the bin in the cwd's own node_modules/.bin", async () => {
    const bin = "/repo/wt/node_modules/.bin/playwright";
    expect(await resolveLocalPlaywrightBin("/repo/wt", existsIn([bin]))).toBe(bin);
  });

  it("walks up to a parent's node_modules/.bin (monorepo/workspace root)", async () => {
    const bin = "/repo/node_modules/.bin/playwright";
    expect(await resolveLocalPlaywrightBin("/repo/packages/app", existsIn([bin]))).toBe(bin);
  });

  it("returns null when no node_modules/.bin holds playwright up to the root", async () => {
    expect(await resolveLocalPlaywrightBin("/repo/wt", existsIn([]))).toBeNull();
  });
});

describe("resolveLocalPlaywrightBin against a REAL filesystem", () => {
  let root: string;
  let bare: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "factory-e2e-localbin-"));
    bare = await mkdtemp(join(tmpdir(), "factory-e2e-nobin-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  });

  it("finds playwright planted in a PARENT's node_modules/.bin, walking up from a nested cwd", async () => {
    const binPath = join(root, "node_modules", ".bin", "playwright");
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    await writeFile(binPath, "#!/bin/sh\n");
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });

    expect(await resolveLocalPlaywrightBin(nested)).toBe(binPath);
  });

  it("returns null when no node_modules/.bin holds playwright up to the filesystem root", async () => {
    expect(await resolveLocalPlaywrightBin(bare)).toBeNull();
  });
});

describe("DefaultPlaywrightTool", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  const found =
    (bin: string): LocalPlaywrightResolver =>
    async () =>
      bin;
  const missing: LocalPlaywrightResolver = async () => null;
  const lastCall = (): readonly [string, readonly string[] | undefined] => {
    const call = execMock.mock.calls[execMock.mock.calls.length - 1]!;
    return [call[0], call[1]];
  };

  it("execs the resolved local playwright with test/--reporter=json (never npx)", async () => {
    execMock.mockResolvedValue(res("{}"));
    await new DefaultPlaywrightTool(found("/wt/node_modules/.bin/playwright")).run({ cwd: "/wt" });
    const [cmd, args] = lastCall();
    expect(cmd).toBe("/wt/node_modules/.bin/playwright");
    expect(args).toEqual(["test", "--reporter=json"]);
  });

  it("passes testDir as a positional filter and grep as --grep", async () => {
    execMock.mockResolvedValue(res("{}"));
    await new DefaultPlaywrightTool(found("/wt/node_modules/.bin/playwright")).run({
      cwd: "/wt",
      testDir: "e2e/checkout.spec.ts",
      grep: "checkout",
    });
    const [, args] = lastCall();
    expect(args).toEqual(["test", "e2e/checkout.spec.ts", "--grep", "checkout", "--reporter=json"]);
  });

  it("passes --config when given, BEFORE the reporter flag", async () => {
    execMock.mockResolvedValue(res("{}"));
    await new DefaultPlaywrightTool(found("/wt/node_modules/.bin/playwright")).run({
      cwd: "/wt",
      config: "/wt/.factory-e2e-throwaway.config.cjs",
    });
    const [, args] = lastCall();
    expect(args).toEqual([
      "test",
      "--config",
      "/wt/.factory-e2e-throwaway.config.cjs",
      "--reporter=json",
    ]);
  });

  it("omits the testDir positional when --config is given (the config's own testDir governs)", async () => {
    execMock.mockResolvedValue(res("{}"));
    await new DefaultPlaywrightTool(found("/wt/node_modules/.bin/playwright")).run({
      cwd: "/wt",
      config: "/wt/.factory-e2e-throwaway.config.cjs",
      testDir: "should-be-ignored",
    });
    const [, args] = lastCall();
    expect(args).not.toContain("should-be-ignored");
  });

  it("FAILS CLOSED (no exec, never npx) when no local bin exists", async () => {
    const result: E2eProcResult = await new DefaultPlaywrightTool(missing).run({ cwd: "/wt" });
    expect(execMock).not.toHaveBeenCalled();
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("playwright");
  });

  it("merges the passed env over process.env via the shared exec seam", async () => {
    execMock.mockResolvedValue(res("{}"));
    await new DefaultPlaywrightTool(found("/wt/node_modules/.bin/playwright")).run({
      cwd: "/wt",
      env: { BASE_URL: "http://localhost:3000" },
    });
    const call = execMock.mock.calls[execMock.mock.calls.length - 1]!;
    const opts = call[2] as Record<string, unknown>;
    expect(opts.env).toEqual({ BASE_URL: "http://localhost:3000" });
    expect(opts.envMode).toBeUndefined();
  });

  it("replaceEnv:true forwards envMode:'replace' to the shared exec seam (Decision 39 W5 scrub)", async () => {
    execMock.mockResolvedValue(res("{}"));
    await new DefaultPlaywrightTool(found("/wt/node_modules/.bin/playwright")).run({
      cwd: "/wt",
      env: { BASE_URL: "http://localhost:3000" },
      replaceEnv: true,
    });
    const call = execMock.mock.calls[execMock.mock.calls.length - 1]!;
    const opts = call[2] as Record<string, unknown>;
    expect(opts.envMode).toBe("replace");
  });
});
