import { describe, it, expect } from "vitest";
import { defaultConfig } from "../config/schema.js";
import type { Config } from "../types/index.js";
import { dialForRung } from "./model-dial.js";

const cfg = defaultConfig();
const CEILING = cfg.quota.producerModels.high;

describe("model-dial — producer model TRACKS the dial (D21/D25)", () => {
  it("rung 0 returns config.quota.producerModels for the matching RiskTier (never a literal)", () => {
    expect(dialForRung("low", 0, cfg).model).toBe(cfg.quota.producerModels.low);
    expect(dialForRung("medium", 0, cfg).model).toBe(cfg.quota.producerModels.medium);
    expect(dialForRung("high", 0, cfg).model).toBe(cfg.quota.producerModels.high);
  });

  it("rung 0 carries no effort override and no prior-failure context", () => {
    const r0 = dialForRung("low", 0, cfg);
    expect(r0.effort).toBeUndefined();
    expect(r0.injectsPriorFailure).toBe(false);
  });

  it("a config OVERRIDE of producerModels flows through the dial (base + ceiling)", () => {
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
    // The escalation ceiling tracks the overridden high-tier model, not a literal.
    expect(dialForRung("low", 2, overridden).model).toBe("custom-high");
  });
});

describe("model-dial — combined model→effort escalation ladder (D25)", () => {
  // The ladder climbs the MODEL to its ceiling first (jump straight to the
  // high-tier model on the first escalation rung), THEN climbs effort
  // (xhigh→max). Every escalation rung also injects prior-failure context.

  it("rung 1 = SAME dialed model, fresh context (no escalation, no prior-failure, no effort)", () => {
    const r1 = dialForRung("low", 1, cfg);
    expect(r1.model).toBe(cfg.quota.producerModels.low);
    expect(r1.model).toBe(dialForRung("low", 0, cfg).model); // model did NOT change
    expect(r1.injectsPriorFailure).toBe(false);
    expect(r1.effort).toBeUndefined();
  });

  describe("low / medium base (below the ceiling): model climbs to ceiling, THEN effort", () => {
    for (const tier of ["low", "medium"] as const) {
      it(`${tier}: rung 2 JUMPS straight to the ceiling model (default effort), injects prior-failure`, () => {
        const r2 = dialForRung(tier, 2, cfg);
        expect(r2.model).toBe(CEILING); // jump to ceiling, NOT one tier up
        expect(r2.effort).toBeUndefined(); // model first; effort not yet climbing
        expect(r2.injectsPriorFailure).toBe(true);
      });

      it(`${tier}: rung 3 = ceiling model + xhigh effort`, () => {
        const r3 = dialForRung(tier, 3, cfg);
        expect(r3.model).toBe(CEILING);
        expect(r3.effort).toBe("xhigh");
        expect(r3.injectsPriorFailure).toBe(true);
      });

      it(`${tier}: rung 4 = ceiling model + max effort`, () => {
        const r4 = dialForRung(tier, 4, cfg);
        expect(r4.model).toBe(CEILING);
        expect(r4.effort).toBe("max");
        expect(r4.injectsPriorFailure).toBe(true);
      });
    }
  });

  describe("high base (already at the ceiling): skip the model jump, climb effort immediately", () => {
    it("rung 2 = ceiling model + xhigh effort (no wasted model-jump rung)", () => {
      const r2 = dialForRung("high", 2, cfg);
      expect(r2.model).toBe(CEILING);
      expect(r2.model).toBe(dialForRung("high", 0, cfg).model); // already at ceiling
      expect(r2.effort).toBe("xhigh");
      expect(r2.injectsPriorFailure).toBe(true);
    });

    it("rung 3 = ceiling model + max effort", () => {
      const r3 = dialForRung("high", 3, cfg);
      expect(r3.model).toBe(CEILING);
      expect(r3.effort).toBe("max");
    });

    it("rung 4 SATURATES at ceiling model + max effort (nothing above max)", () => {
      const r4 = dialForRung("high", 4, cfg);
      expect(r4.model).toBe(CEILING);
      expect(r4.effort).toBe("max");
      // saturated: identical model+effort to rung 3, the changed variable is context
      expect(r4.effort).toBe(dialForRung("high", 3, cfg).effort);
    });
  });

  it("rejects a negative / non-integer rung (LOUD)", () => {
    expect(() => dialForRung("low", -1, cfg)).toThrow();
    expect(() => dialForRung("low", 1.5, cfg)).toThrow();
  });
});
