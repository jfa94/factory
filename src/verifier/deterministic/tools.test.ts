/**
 * WS6 — tools.ts unit vectors for the pure parsers + the git-probe commit walk.
 *
 *  - extractMutationScore: pulls `.metrics.mutationScore` (finite number) or null.
 *  - parseCoverageSummary: dual-shape (`{pct}` object OR bare scalar) total parse,
 *    null when ANY of the four metrics is missing.
 *  - DefaultGitProbe.commits: OLDEST-FIRST reversal of `git log` + merge classified
 *    against its FIRST parent + `[task-id]` tag detection (exec is mocked — no git).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/index.js")>();
  return { ...actual, exec: vi.fn() };
});

import { exec, type ExecResult } from "../../shared/index.js";
import { DefaultGitProbe, extractMutationScore, parseCoverageSummary } from "./tools.js";

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
