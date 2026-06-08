/**
 * WS12 — dead-surface scan (Decision 22, Δ S).
 *
 * The parse + scope core is pure and unit-tested against canned tool output; the
 * orchestration is exercised with a FAKE {@link DeadSurfaceRunner} so every degrade
 * path (unavailable → skipped, truncated/killed/threw → error, empty diff) is
 * covered without invoking a real tool. The contract under test: report-only, never
 * throws.
 */
import { describe, it, expect } from "vitest";
import {
  parseTsPruneOutput,
  scopeToChangedFiles,
  scanDeadSurface,
  type DeadSurfaceRunner,
  type DeadSurfaceRunResult,
} from "./dead-surface.js";

describe("parseTsPruneOutput", () => {
  it("parses `file:line - name` findings", () => {
    const out = parseTsPruneOutput("src/a.ts:42 - foo\nsrc/b.ts:7 - bar");
    expect(out).toEqual([
      { file: "src/a.ts", line: 42, name: "foo" },
      { file: "src/b.ts", line: 7, name: "bar" },
    ]);
  });

  it("keeps the trailing `(used in module)` annotation verbatim in name", () => {
    const out = parseTsPruneOutput("src/a.ts:42 - foo (used in module)");
    expect(out).toEqual([{ file: "src/a.ts", line: 42, name: "foo (used in module)" }]);
  });

  it("ignores blank lines and non-matching banner lines", () => {
    const out = parseTsPruneOutput("\nscanning project...\nsrc/a.ts:1 - x\n   \ndone");
    expect(out).toEqual([{ file: "src/a.ts", line: 1, name: "x" }]);
  });

  it("returns [] for empty output", () => {
    expect(parseTsPruneOutput("")).toEqual([]);
  });
});

describe("scopeToChangedFiles", () => {
  it("keeps only findings whose file is in the diff, order-preserving", () => {
    const findings = [
      { file: "src/a.ts", line: 1, name: "a" },
      { file: "src/b.ts", line: 2, name: "b" },
      { file: "src/c.ts", line: 3, name: "c" },
    ];
    expect(scopeToChangedFiles(findings, ["src/c.ts", "src/a.ts"])).toEqual([
      { file: "src/a.ts", line: 1, name: "a" },
      { file: "src/c.ts", line: 3, name: "c" },
    ]);
  });

  it("normalizes a leading `./` on both sides before membership", () => {
    const findings = [{ file: "./src/a.ts", line: 1, name: "a" }];
    expect(scopeToChangedFiles(findings, ["src/a.ts"])).toHaveLength(1);
    expect(
      scopeToChangedFiles([{ file: "src/a.ts", line: 1, name: "a" }], ["./src/a.ts"]),
    ).toHaveLength(1);
  });

  it("yields nothing when the diff is empty", () => {
    expect(scopeToChangedFiles([{ file: "src/a.ts", line: 1, name: "a" }], [])).toEqual([]);
  });
});

/** A canned-output runner — never shells out. */
function fakeRunner(result: DeadSurfaceRunResult | Error, tool = "ts-prune"): DeadSurfaceRunner {
  return {
    tool,
    run: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
  };
}

const okResult = (stdout: string): DeadSurfaceRunResult => ({
  available: true,
  code: 0,
  stdout,
  stderr: "",
  truncated: false,
});

describe("scanDeadSurface — report-only orchestration", () => {
  it("ok: parses + scopes findings to the run diff", async () => {
    const runner = fakeRunner(okResult("src/a.ts:1 - foo\nsrc/other.ts:2 - bar"));
    const report = await scanDeadSurface(runner, ["src/a.ts"], { cwd: "/repo" });
    expect(report.status).toBe("ok");
    expect(report.total_found).toBe(2);
    expect(report.findings).toEqual([{ file: "src/a.ts", line: 1, name: "foo" }]);
    expect(report.changed_file_count).toBe(1);
    expect(report.note).toContain("1 unreferenced export");
  });

  it("ok with empty diff: reports the empty-diff note and no findings", async () => {
    const runner = fakeRunner(okResult("src/a.ts:1 - foo"));
    const report = await scanDeadSurface(runner, [], { cwd: "/repo" });
    expect(report.status).toBe("ok");
    expect(report.total_found).toBe(1);
    expect(report.findings).toEqual([]);
    expect(report.note).toContain("run diff is empty");
  });

  it("skipped: an unavailable tool is reported, not raised", async () => {
    const runner = fakeRunner({
      available: false,
      code: null,
      stdout: "",
      stderr: "command not found",
      truncated: false,
    });
    const report = await scanDeadSurface(runner, ["src/a.ts"], { cwd: "/repo" });
    expect(report.status).toBe("skipped");
    expect(report.findings).toEqual([]);
    expect(report.note).toContain("not available");
  });

  it("error: truncated output is untrusted (not reported)", async () => {
    const runner = fakeRunner({
      available: true,
      code: 0,
      stdout: "src/a.ts:1 - foo",
      stderr: "",
      truncated: true,
    });
    const report = await scanDeadSurface(runner, ["src/a.ts"], { cwd: "/repo" });
    expect(report.status).toBe("error");
    expect(report.findings).toEqual([]);
    expect(report.note).toContain("truncated");
  });

  it("error: a killed run (code null) is reported", async () => {
    const runner = fakeRunner({
      available: true,
      code: null,
      stdout: "",
      stderr: "",
      truncated: false,
    });
    const report = await scanDeadSurface(runner, ["src/a.ts"], { cwd: "/repo" });
    expect(report.status).toBe("error");
    expect(report.note).toContain("killed");
  });

  it("error: a runner that throws degrades to an error report, never a crash", async () => {
    const runner = fakeRunner(new Error("spawn blew up"));
    const report = await scanDeadSurface(runner, ["src/a.ts"], { cwd: "/repo" });
    expect(report.status).toBe("error");
    expect(report.note).toContain("spawn blew up");
    expect(report.tool).toBe("ts-prune");
  });
});
