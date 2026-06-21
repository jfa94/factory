import { describe, it, expect } from "vitest";
import { defaultConfig } from "../config/schema.js";
import { selectProducerModel } from "./router.js";

const CONFIG = defaultConfig();

describe("D25/D26 router risk-invariance — selectProducerModel varies ONLY the producer dial", () => {
  it("each risk tier selects its configured producer model", () => {
    expect(selectProducerModel("low", CONFIG)).toBe(CONFIG.quota.producerModels.low);
    expect(selectProducerModel("medium", CONFIG)).toBe(CONFIG.quota.producerModels.medium);
    expect(selectProducerModel("high", CONFIG)).toBe(CONFIG.quota.producerModels.high);
  });

  it("the three tiers map to distinct defaults (the dial actually moves)", () => {
    const models = new Set([
      selectProducerModel("low", CONFIG),
      selectProducerModel("medium", CONFIG),
      selectProducerModel("high", CONFIG),
    ]);
    expect(models.size).toBe(3);
  });
});
