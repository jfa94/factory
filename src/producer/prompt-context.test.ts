import { describe, it, expect } from "vitest";
import { buildProducerContext } from "./prompt-context.js";
import { fakeFinding } from "./fakes.js";

describe("prompt-context — holdout integrity (D5/Δ Y)", () => {
  it("the assembled context contains ONLY the visible (holdout-stripped) criteria — there is no holdout field/path", () => {
    const ctx = buildProducerContext({
      taskId: "T1",
      title: "t",
      description: "d",
      visibleCriteria: ["visible-1", "visible-2"],
      files: ["src/a.ts"],
      rung: 0,
    });
    expect(ctx.acceptanceCriteria).toEqual(["visible-1", "visible-2"]);
    // No holdout key surface: assert the structured context has no holdout-* key.
    const keys = Object.keys(ctx);
    expect(keys.some((k) => /holdout/i.test(k))).toBe(false);
  });
});

describe("prompt-context — rung-2 prior-failure injection is the changed variable (D25)", () => {
  it("rung 0/1 inject no prior failures (injectedPriorFailure=false)", () => {
    const ctx = buildProducerContext({
      taskId: "T1",
      title: "t",
      description: "d",
      visibleCriteria: ["c"],
      files: ["f"],
      rung: 1,
    });
    expect(ctx.injectedPriorFailure).toBe(false);
    expect(ctx.priorFailures).toHaveLength(0);
  });

  it("rung 2 with prior-failure notes → injectedPriorFailure=true (the rung-2 context change)", () => {
    const ctx = buildProducerContext({
      taskId: "T1",
      title: "t",
      description: "d",
      visibleCriteria: ["c"],
      files: ["f"],
      rung: 2,
      priorFailures: [{ rung: 1, summary: "merge gate blocked by security" }],
    });
    expect(ctx.injectedPriorFailure).toBe(true);
    expect(ctx.priorFailures[0]?.summary).toContain("security");
  });
});

describe("prompt-context — fix-forward instructions (D27)", () => {
  it("confirmed blockers become concrete fix instructions (PATCH, not nuke)", () => {
    const ctx = buildProducerContext({
      taskId: "T1",
      title: "t",
      description: "d",
      visibleCriteria: ["c"],
      files: ["f"],
      rung: 0,
      confirmedBlockers: [
        fakeFinding({ file: "src/x.ts", line: 42, description: "fix the null deref" }),
      ],
    });
    expect(ctx.fixInstructions).toHaveLength(1);
    expect(ctx.fixInstructions[0]).toMatchObject({
      file: "src/x.ts",
      line: 42,
      description: "fix the null deref",
    });
  });

  it("an uncitable confirmed blocker still yields a fix instruction (file/line omitted)", () => {
    const f = fakeFinding();
    const ctx = buildProducerContext({
      taskId: "T1",
      title: "t",
      description: "d",
      visibleCriteria: ["c"],
      files: ["f"],
      rung: 0,
      confirmedBlockers: [{ ...f, file: undefined, line: undefined }],
    });
    expect(ctx.fixInstructions[0]?.file).toBeUndefined();
    expect(ctx.fixInstructions[0]?.line).toBeUndefined();
    expect(ctx.fixInstructions[0]?.description.length).toBeGreaterThan(0);
  });

  it("a blocker with a file but NO line carries the file and omits the line", () => {
    const f = fakeFinding();
    const ctx = buildProducerContext({
      taskId: "T1",
      title: "t",
      description: "d",
      visibleCriteria: ["c"],
      files: ["f"],
      rung: 0,
      confirmedBlockers: [{ ...f, file: "src/y.ts", line: undefined }],
    });
    expect(ctx.fixInstructions[0]?.file).toBe("src/y.ts");
    expect(ctx.fixInstructions[0]?.line).toBeUndefined();
  });
});
