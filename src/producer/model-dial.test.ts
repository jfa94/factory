import { describe, it, expect } from "vitest";
import { defaultConfig } from "../config/schema.js";
import type { Config } from "../types/index.js";
import { dialForRung } from "./model-dial.js";

const cfg = defaultConfig();

describe("model-dial — producer model TRACKS the WS5/WS4 dial (D21/D25)", () => {
  it("rung 0 returns config.quota.producerModels for the matching RiskTier (never a literal)", () => {
    expect(dialForRung("low", 0, cfg).model).toBe(cfg.quota.producerModels.low);
    expect(dialForRung("medium", 0, cfg).model).toBe(cfg.quota.producerModels.medium);
    expect(dialForRung("high", 0, cfg).model).toBe(cfg.quota.producerModels.high);
  });

  it("a config OVERRIDE of producerModels flows through the dial", () => {
    const overridden: Config = {
      ...cfg,
      quota: {
        ...cfg.quota,
        producerModels: { low: "custom-low", medium: "custom-mid", high: "custom-high" },
      },
    };
    expect(dialForRung("low", 0, overridden).model).toBe("custom-low");
    expect(dialForRung("medium", 0, overridden).model).toBe("custom-mid");
    expect(dialForRung("high", 0, overridden).model).toBe("custom-high");
  });
});

describe("model-dial — escalation derives from the SAME producerModels map (D25)", () => {
  // Escalation is DERIVED, not stored (Δ V): the observable is the dialed `model`
  // (and injectsPriorFailure), compared against rung 0 — there is no `escalated`
  // boolean to read back.
  it("rung 1 = SAME dialed model, fresh context (no model escalation, no prior-failure)", () => {
    const r1 = dialForRung("low", 1, cfg);
    expect(r1.model).toBe(cfg.quota.producerModels.low);
    expect(r1.model).toBe(dialForRung("low", 0, cfg).model); // model did NOT change
    expect(r1.injectsPriorFailure).toBe(false);
  });

  it("rung 2 from low ESCALATES the model one tier up (low→medium) + injects prior-failure", () => {
    const r2 = dialForRung("low", 2, cfg);
    expect(r2.model).toBe(cfg.quota.producerModels.medium);
    expect(r2.model).not.toBe(dialForRung("low", 0, cfg).model); // model CHANGED
    expect(r2.injectsPriorFailure).toBe(true);
  });

  it("rung 2 from medium ESCALATES medium→high", () => {
    const r2 = dialForRung("medium", 2, cfg);
    expect(r2.model).toBe(cfg.quota.producerModels.high);
    expect(r2.model).not.toBe(dialForRung("medium", 0, cfg).model); // model CHANGED
  });

  it("rung 2 from high is at the CEILING: model unchanged, but context still changes (injects=true)", () => {
    const r2 = dialForRung("high", 2, cfg);
    expect(r2.model).toBe(cfg.quota.producerModels.high);
    expect(r2.model).toBe(dialForRung("high", 0, cfg).model); // ceiling: model unchanged
    // The changed variable at the ceiling is the injected context.
    expect(r2.injectsPriorFailure).toBe(true);
  });

  it("rejects a negative / non-integer rung (LOUD)", () => {
    expect(() => dialForRung("low", -1, cfg)).toThrow();
    expect(() => dialForRung("low", 1.5, cfg)).toThrow();
  });
});
