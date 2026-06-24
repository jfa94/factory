/**
 * WS6 — tools.ts unit vectors for the pure parsers + the git-probe commit walk.
 *
 *  - extractMutationScore: pulls `.metrics.mutationScore` (finite number) or null.
 *  - parseCoverageSummary: dual-shape (`{pct}` object OR bare scalar) total parse,
 *    null when ANY of the four metrics is missing.
 *  - DefaultGitProbe.commits: OLDEST-FIRST reversal of `git log` + merge classified
 *    against its FIRST parent + `[task-id]` tag detection (exec is mocked — no git).
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
  DefaultBuildTool,
  DefaultEslintTool,
  DefaultGitProbe,
  DefaultSemgrepTool,
  DefaultStrykerTool,
  DefaultTscTool,
  DefaultVitestTool,
  defaultGateTools,
  defaultLocalBinResolver,
  extractMutationScore,
  parseCoverageSummary,
  resolveLocalBin,
  type LocalBinResolver,
} from "./tools.js";

const execMock = vi.mocked(exec);

function res(stdout: string, code = 0, truncated = false): ExecResult {
  return { stdout, stderr: "", code, signal: null, truncated };
}

describe("extractMutationScore", () => {
  it("returns the finite metrics.mutationScore", () => {
    expect(extractMutationScore({ metrics: { mutationScore: 85.4 } })).toBe(85.4);
    expect(extractMutationScore({ metrics: { mutationScore: 0 } })).toBe(0);
  });

  it("returns null when the score is absent / non-numeric / non-finite", () => {
    expect(extractMutationScore({ metrics: {} })).toBeNull();
    expect(extractMutationScore({ metrics: { mutationScore: "80" } })).toBeNull();
    expect(extractMutationScore({ metrics: { mutationScore: Number.NaN } })).toBeNull();
    expect(
      extractMutationScore({ metrics: { mutationScore: Number.POSITIVE_INFINITY } }),
    ).toBeNull();
  });

  it("returns null when the shape is wrong (no metrics / not an object)", () => {
    expect(extractMutationScore({})).toBeNull();
    expect(extractMutationScore({ metrics: null })).toBeNull();
    expect(extractMutationScore(null)).toBeNull();
    expect(extractMutationScore("nope")).toBeNull();
  });
});

describe("extractMutationScore — derive from schema-1.0 mutants (stock json reporter)", () => {
  // Build a schema-1.0 report shape: { files: { <path>: { mutants: [{ status }] } } }.
  // The stock stryker `json` reporter emits NO top-level `.metrics`, so the gate must
  // compute the score from the per-file mutant tally (Stryker's own formula:
  //   detected = killed + timeout; valid = detected + survived + noCoverage;
  //   score = detected / valid * 100).
  function report(...statuses: string[]) {
    return { files: { "a.ts": { mutants: statuses.map((status) => ({ status })) } } };
  }

  it("computes detected/valid*100 from mutant statuses (no metrics field)", () => {
    // 3 killed + 1 survived → detected 3, valid 4 → 75.
    expect(extractMutationScore(report("Killed", "Killed", "Killed", "Survived"))).toBe(75);
  });

  it("all detected (killed/timeout) → 100", () => {
    expect(extractMutationScore(report("Killed", "Timeout", "Killed"))).toBe(100);
  });

  it("all undetected (survived/noCoverage) → 0", () => {
    expect(extractMutationScore(report("Survived", "NoCoverage"))).toBe(0);
  });

  it("excludes CompileError/RuntimeError/Ignored/Pending from `valid`", () => {
    // 1 killed + 1 survived = 50; the four non-valid statuses must NOT move it.
    const score = extractMutationScore(
      report("Killed", "Survived", "CompileError", "RuntimeError", "Ignored", "Pending"),
    );
    expect(score).toBe(50);
  });

  it("returns null when there are zero VALID mutants (only ignored/errored)", () => {
    expect(
      extractMutationScore(report("CompileError", "RuntimeError", "Ignored", "Pending")),
    ).toBeNull();
  });

  it("tallies status strings case-insensitively", () => {
    // killed, KILLED, Survived → detected 2, valid 3 → 66.67.
    expect(extractMutationScore(report("killed", "KILLED", "Survived"))).toBeCloseTo(200 / 3, 10);
  });

  it("aggregates across multiple files", () => {
    const multi = {
      files: {
        "a.ts": { mutants: [{ status: "Killed" }, { status: "Survived" }] },
        "b.ts": { mutants: [{ status: "Killed" }, { status: "Timeout" }] },
      },
    };
    // detected = 3 (2 killed + 1 timeout), valid = 4 → 75.
    expect(extractMutationScore(multi)).toBe(75);
  });

  it("prefers a finite .metrics.mutationScore (fast path) even when files are present", () => {
    // metrics wins: 42 is returned, NOT the 100 the all-killed files would compute.
    const withBoth = { metrics: { mutationScore: 42 }, ...report("Killed", "Killed") };
    expect(extractMutationScore(withBoth)).toBe(42);
  });

  it("falls through to the mutant tally when .metrics.mutationScore is non-finite", () => {
    const withNaN = { metrics: { mutationScore: Number.NaN }, ...report("Killed", "Survived") };
    expect(extractMutationScore(withNaN)).toBe(50);
  });

  it("ignores files whose `mutants` is missing or not an array", () => {
    const messy = {
      files: {
        "a.ts": { mutants: [{ status: "Killed" }, { status: "Survived" }] },
        "b.ts": {}, // no mutants
        "c.ts": { mutants: "nope" }, // wrong type
      },
    };
    expect(extractMutationScore(messy)).toBe(50);
  });
});

describe("parseCoverageSummary (dual-shape)", () => {
  it("parses the {pct} object shape", () => {
    const r = parseCoverageSummary({
      total: {
        lines: { pct: 90 },
        branches: { pct: 80 },
        functions: { pct: 70 },
        statements: { pct: 60 },
      },
    });
    expect(r).toEqual({ lines: 90, branches: 80, functions: 70, statements: 60 });
  });

  it("parses the bare-scalar shape", () => {
    const r = parseCoverageSummary({
      total: { lines: 90, branches: 80, functions: 70, statements: 60 },
    });
    expect(r).toEqual({ lines: 90, branches: 80, functions: 70, statements: 60 });
  });

  it("returns null when any metric is missing", () => {
    expect(parseCoverageSummary({ total: { lines: 90, branches: 80, functions: 70 } })).toBeNull();
  });

  it("returns null on a wrong outer shape", () => {
    expect(parseCoverageSummary(null)).toBeNull();
    expect(parseCoverageSummary({})).toBeNull();
    expect(parseCoverageSummary({ total: null })).toBeNull();
  });
});

describe("resolveLocalBin + defaultLocalBinResolver against a REAL filesystem", () => {
  // Exercises the PRODUCTION resolver path — the real `pathExists` (fs.access),
  // the real walk-up, and the filesystem-root termination — none of which the
  // injected-predicate unit tests below touch. A regression in the production
  // wiring (wrong path segment, walk-up that never terminates) would pass every
  // mocked test yet break every gate; this is the only test that would catch it.
  let root: string;
  let bare: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "factory-localbin-"));
    bare = await mkdtemp(join(tmpdir(), "factory-nobin-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  });

  it("finds a tool planted in a PARENT's node_modules/.bin, walking up from a nested cwd", async () => {
    const binPath = join(root, "node_modules", ".bin", "tsc");
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    await writeFile(binPath, "#!/bin/sh\n");
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });

    expect(await resolveLocalBin(nested, "tsc")).toBe(binPath);
    // defaultLocalBinResolver wires opts.cwd → the real resolveLocalBin/pathExists.
    expect(await defaultLocalBinResolver("tsc", { cwd: nested })).toBe(binPath);
  });

  it("returns null when no node_modules/.bin holds the tool up to the filesystem root (real termination)", async () => {
    expect(await resolveLocalBin(bare, "vitest")).toBeNull();
    expect(await defaultLocalBinResolver("vitest", { cwd: bare })).toBeNull();
  });
});

describe("resolveLocalBin (walk-up node_modules/.bin)", () => {
  const existsIn = (paths: readonly string[]): ((p: string) => Promise<boolean>) => {
    const set = new Set(paths);
    return async (p: string) => set.has(p);
  };

  it("resolves the bin in the cwd's own node_modules/.bin", async () => {
    const bin = "/repo/wt/node_modules/.bin/vitest";
    expect(await resolveLocalBin("/repo/wt", "vitest", existsIn([bin]))).toBe(bin);
  });

  it("walks up to a parent's node_modules/.bin (monorepo/workspace root)", async () => {
    const bin = "/repo/node_modules/.bin/vitest";
    expect(await resolveLocalBin("/repo/packages/app", "vitest", existsIn([bin]))).toBe(bin);
  });

  it("returns null when no node_modules/.bin holds the tool up to the root", async () => {
    expect(await resolveLocalBin("/repo/wt", "vitest", existsIn([]))).toBeNull();
  });
});

describe("Default command tools: local-bin resolution + test-gate coverage", () => {
  // NB: brace body — a bare `() => execMock.mockReset()` RETURNS the mock, which
  // vitest would register as a teardown callback and invoke (see the probe describe).
  beforeEach(() => {
    execMock.mockReset();
  });

  const found =
    (bin: string): LocalBinResolver =>
    async () =>
      bin;
  const missing: LocalBinResolver = async () => null;
  const lastCall = (): readonly [string, readonly string[] | undefined] => {
    const call = execMock.mock.calls[execMock.mock.calls.length - 1]!;
    return [call[0], call[1]];
  };

  it("DefaultTscTool execs the resolved local tsc with --noEmit (never npx)", async () => {
    execMock.mockResolvedValue(res(""));
    await new DefaultTscTool(found("/wt/node_modules/.bin/tsc")).typecheck({ cwd: "/wt" });
    const [cmd, args] = lastCall();
    expect(cmd).toBe("/wt/node_modules/.bin/tsc");
    expect(args).toEqual(["--noEmit"]);
  });

  it("DefaultTscTool FAILS CLOSED (no exec, never npx) when no local bin exists", async () => {
    // The whole reason this code exists: a bare `npx tsc` under corepack+pnpm
    // resolves a REMOTE registry decoy. So a missing local bin must NOT shell out
    // to npx — it returns a synthetic non-zero result that fails the gate closed,
    // naming the tool, without touching a subprocess or the network.
    const result = await new DefaultTscTool(missing).typecheck({ cwd: "/wt" });
    expect(execMock).not.toHaveBeenCalled();
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("tsc");
  });

  it("DefaultVitestTool DISABLES coverage on the diff-scoped test gate", async () => {
    execMock.mockResolvedValue(res(""));
    await new DefaultVitestTool(found("/wt/node_modules/.bin/vitest")).run(["a.test.ts"], {
      cwd: "/wt",
    });
    const [cmd, args] = lastCall();
    expect(cmd).toBe("/wt/node_modules/.bin/vitest");
    expect(args).toEqual(["run", "--coverage.enabled=false", "a.test.ts"]);
  });

  it("DefaultVitestTool also FAILS CLOSED when no local vitest bin exists (never npx)", async () => {
    const result = await new DefaultVitestTool(missing).run([], { cwd: "/wt" });
    expect(execMock).not.toHaveBeenCalled();
    expect(result.code).toBe(127);
    expect(result.stderr).toContain("vitest");
  });

  it("DefaultEslintTool execs the resolved local eslint over `.`", async () => {
    execMock.mockResolvedValue(res(""));
    await new DefaultEslintTool(found("/wt/node_modules/.bin/eslint")).lint({ cwd: "/wt" });
    const [cmd, args] = lastCall();
    expect(cmd).toBe("/wt/node_modules/.bin/eslint");
    expect(args).toEqual(["."]);
  });

  it("DefaultStrykerTool execs the resolved local stryker with the mutate CSV", async () => {
    execMock.mockResolvedValue(res("")); // report read fails → absent; we assert only the argv
    await new DefaultStrykerTool(found("/wt/node_modules/.bin/stryker")).run(["a.ts", "b.ts"], {
      cwd: "/wt",
    });
    const strykerCall = execMock.mock.calls.find((c) => String(c[0]).endsWith("stryker"))!;
    expect(strykerCall[0]).toBe("/wt/node_modules/.bin/stryker");
    expect(strykerCall[1]).toEqual(["run", "--mutate", "a.ts,b.ts"]);
  });
});

describe("gate env injection (CI parity — quality.gateEnv)", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  const found =
    (bin: string): LocalBinResolver =>
    async () =>
      bin;
  const lastOpts = (): Record<string, unknown> => {
    const call = execMock.mock.calls[execMock.mock.calls.length - 1]!;
    return (call[2] ?? {}) as Record<string, unknown>;
  };

  const GATE_ENV = { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" };

  it("a runTool-backed tool (vitest) spawns with the injected env merged", async () => {
    execMock.mockResolvedValue(res(""));
    await new DefaultVitestTool(found("/wt/node_modules/.bin/vitest"), GATE_ENV).run([], {
      cwd: "/wt",
    });
    expect(lastOpts()).toEqual({ cwd: "/wt", env: GATE_ENV });
  });

  it("DefaultBuildTool spawns `npm run build` with the injected env", async () => {
    execMock.mockResolvedValue(res(""));
    await new DefaultBuildTool(GATE_ENV).build({ cwd: "/wt" });
    const [cmd, args] = [execMock.mock.calls[0]![0], execMock.mock.calls[0]![1]];
    expect(cmd).toBe("npm");
    expect(args).toEqual(["run", "build"]);
    expect(lastOpts()).toEqual({ cwd: "/wt", env: GATE_ENV });
  });

  it("DefaultSemgrepTool spawns the security command with the injected env", async () => {
    execMock.mockResolvedValue(res(""));
    await new DefaultSemgrepTool(GATE_ENV).run(["semgrep", "--config", "auto"], { cwd: "/wt" });
    const [cmd, args] = [execMock.mock.calls[0]![0], execMock.mock.calls[0]![1]];
    expect(cmd).toBe("semgrep");
    expect(args).toEqual(["--config", "auto"]);
    expect(lastOpts()).toEqual({ cwd: "/wt", env: GATE_ENV });
  });

  it("defaultGateTools(env) bakes the env into every spawning tool (build proof)", async () => {
    execMock.mockResolvedValue(res(""));
    const tools = defaultGateTools(GATE_ENV);
    await tools.build.build({ cwd: "/wt" });
    expect(lastOpts()).toEqual({ cwd: "/wt", env: GATE_ENV });
  });

  it("defaults to an empty env when none is configured (no surprise vars)", async () => {
    execMock.mockResolvedValue(res(""));
    await new DefaultBuildTool().build({ cwd: "/wt" });
    expect(lastOpts()).toEqual({ cwd: "/wt", env: {} });
  });
});

describe("DefaultGitProbe.commits (oldest-first + merge first-parent + tag)", () => {
  beforeEach(() => {
    // NB: a brace body — `() => execMock.mockReset()` would RETURN the mock, which
    // vitest registers as a teardown callback and invokes (a bare exec()) at cleanup.
    execMock.mockReset();
  });

  /**
   * Script the git calls the probe makes. `shasNewestFirst` is what `git log`
   * emits; `parents`/`files`/`message` are keyed by sha.
   */
  function scriptGit(spec: {
    shasNewestFirst: string[];
    parents: Record<string, string>;
    files: Record<string, string[]>;
    message: Record<string, string>;
  }): void {
    execMock.mockImplementation(async (_cmd: string, args: readonly string[] = []) => {
      const a = args.join(" ");
      if (a.startsWith("log --format=%H")) return res(spec.shasNewestFirst.join("\n"));
      if (a.startsWith("show -s --format=%P")) {
        const sha = args[args.length - 1]!;
        return res(spec.parents[sha] ?? "");
      }
      if (a.startsWith("diff-tree")) {
        const sha = args[args.length - 1]!; // last arg is the commit in both shapes
        return res((spec.files[sha] ?? []).join("\n"));
      }
      if (a.startsWith("log -1 --format=%s%n%b")) {
        const sha = args[args.length - 1]!;
        return res(spec.message[sha] ?? "");
      }
      throw new Error(`unexpected git call: git ${a}`);
    });
  }

  it("reverses git log to OLDEST-FIRST and detects the [task-id] tag", async () => {
    scriptGit({
      shasNewestFirst: ["c3", "c2", "c1"],
      parents: { c1: "p0", c2: "c1", c3: "c2" },
      files: { c1: ["a.test.ts"], c2: ["a.ts"], c3: ["b.ts"] },
      message: { c1: "test [T1]", c2: "impl [T1]", c3: "chore no tag" },
    });
    const probe = new DefaultGitProbe();
    const out = await probe.commits("base", "T1", { cwd: "/wt" });

    expect(out.map((c) => c.sha)).toEqual(["c1", "c2", "c3"]); // oldest-first
    expect(out.map((c) => c.tagged)).toEqual([true, true, false]);
    expect(out[0]!.files).toEqual(["a.test.ts"]);
  });

  it("classifies a merge against its FIRST parent (parentCount > 1)", async () => {
    // m is a merge of first-parent f1 and second-parent f2.
    scriptGit({
      shasNewestFirst: ["m"],
      parents: { m: "f1 f2" },
      files: { m: ["merged.ts"] },
      message: { m: "merge [T1]" },
    });
    const probe = new DefaultGitProbe();
    const out = await probe.commits("base", "T1", { cwd: "/wt" });

    expect(out).toHaveLength(1);
    expect(out[0]!.parentCount).toBe(2);
    expect(out[0]!.files).toEqual(["merged.ts"]);
    // The merge diff-tree was invoked with the FIRST parent (f1), not f2.
    const diffTreeCall = execMock.mock.calls.find((c) => c[1]?.join(" ").startsWith("diff-tree"));
    expect(diffTreeCall?.[1]).toContain("f1");
    expect(diffTreeCall?.[1]).not.toContain("f2");
  });

  it("throws LOUD when git log output is truncated", async () => {
    execMock.mockImplementation(async (_cmd, args: readonly string[] = []) => {
      if (args.join(" ").startsWith("log --format=%H")) return res("c1", 0, true);
      return res("");
    });
    const probe = new DefaultGitProbe();
    await expect(probe.commits("base", "T1", { cwd: "/wt" })).rejects.toThrow(/truncated/i);
  });
});
