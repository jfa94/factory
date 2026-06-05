import { describe, it, expect } from "vitest";
import { buildGenerateSpawn, buildReviewSpawn, type GenerateResult } from "./agents.js";
import { SPEC_DEFAULTS } from "../config/index.js";
import type { Prd } from "./gh.js";
import type { SpecTask } from "./schema.js";

const prd: Prd = {
  issue_number: 123,
  title: "Checkout",
  body: "Users must be able to check out.",
  labels: ["prd"],
  body_truncated: false,
};

const task: SpecTask = {
  task_id: "task_1",
  title: "Add checkout",
  description: "checkout flow",
  files: ["src/checkout.ts"],
  acceptance_criteria: ["checkout returns 201"],
  tests_to_write: ["checkout returns 201"],
  depends_on: [],
  risk_tier: "high",
  risk_rationale: "payment path",
};

const generated: GenerateResult = { specMd: "# spec", slug: "checkout", tasks: [task] };

describe("D21 apex pin — spec generate spawn is UNCONDITIONALLY opus/max", () => {
  it("D21: generate spawn pins model=opus + effort=max", () => {
    const s = buildGenerateSpawn(prd);
    expect(s.model).toBe(SPEC_DEFAULTS.specModel);
    expect(s.effort).toBe(SPEC_DEFAULTS.specEffort);
    expect(s.model).toBe("opus");
    expect(s.effort).toBe("max");
    expect(s.role).toBe("spec-generator");
  });

  it("D21: review spawn pins model=opus + effort=max", () => {
    const s = buildReviewSpawn(prd, generated);
    expect(s.model).toBe("opus");
    expect(s.effort).toBe("max");
    expect(s.role).toBe("spec-reviewer");
  });

  it("D21: the pin does NOT change with risk_tier, task count, or PRD size", () => {
    const lowRiskTask: SpecTask = { ...task, risk_tier: "low", risk_rationale: "trivial" };
    const manyTasks: GenerateResult = {
      specMd: "x",
      slug: "s",
      tasks: [task, lowRiskTask, { ...task, task_id: "task_3" }],
    };
    const bigPrd: Prd = { ...prd, body: "x".repeat(50_000) };

    for (const p of [prd, bigPrd]) {
      expect(buildGenerateSpawn(p).model).toBe("opus");
      expect(buildGenerateSpawn(p).effort).toBe("max");
      for (const g of [generated, manyTasks]) {
        const r = buildReviewSpawn(p, g);
        expect(r.model).toBe("opus");
        expect(r.effort).toBe("max");
      }
    }
  });

  it("D21: there is no config/risk override path — the spawn carries no tier field", () => {
    const s = buildGenerateSpawn(prd);
    expect(s).not.toHaveProperty("risk_tier");
    expect(s).not.toHaveProperty("riskTier");
  });

  it("generate spawn forwards the PRD context the agent needs", () => {
    const s = buildGenerateSpawn(prd);
    expect(s.context.issue_number).toBe(123);
    expect(s.context.title).toBe("Checkout");
  });
});
