import { describe, expect, it } from "vitest";
import { isRunScopedBranch, parseRunScopedBranch, runScopedBranch } from "./branch.js";

describe("Δ M — run-scoped branch naming", () => {
  it("builds factory/<run_id>/<task_id>", () => {
    expect(runScopedBranch("run-20260604-101500", "t1")).toBe("factory/run-20260604-101500/t1");
  });

  it("two different runs with the SAME task_id yield distinct refs (no cross-run collision)", () => {
    const a = runScopedBranch("run-A", "t1");
    const b = runScopedBranch("run-B", "t1");
    expect(a).not.toBe(b);
    expect(a).toBe("factory/run-A/t1");
    expect(b).toBe("factory/run-B/t1");
  });

  it("throws on an id failing validateId (no malformed ref escapes)", () => {
    expect(() => runScopedBranch("bad id with spaces", "t1")).toThrow(/run-id/);
    expect(() => runScopedBranch("run-1", "bad/slash")).toThrow(/task-id/);
    expect(() => runScopedBranch("run-1", "")).toThrow(/task-id/);
  });

  it("honors a custom prefix and rejects a prefix containing '/'", () => {
    expect(runScopedBranch("run-1", "t1", "wip")).toBe("wip/run-1/t1");
    expect(() => runScopedBranch("run-1", "t1", "a/b")).toThrow(/prefix/);
  });

  it("round-trips via parseRunScopedBranch", () => {
    const ref = runScopedBranch("run-1", "task-2");
    expect(parseRunScopedBranch(ref)).toEqual({
      prefix: "factory",
      runId: "run-1",
      taskId: "task-2",
    });
  });

  it("isRunScopedBranch is false for non-matching / malformed refs", () => {
    expect(isRunScopedBranch("factory/run-1/t1")).toBe(true);
    expect(isRunScopedBranch("task/123")).toBe(false);
    expect(isRunScopedBranch("factory/run-1")).toBe(false); // missing task segment
    expect(isRunScopedBranch("factory/run-1/a/b")).toBe(false); // extra segment
    expect(isRunScopedBranch("factory/bad id/t1")).toBe(false); // invalid run id
  });
});
