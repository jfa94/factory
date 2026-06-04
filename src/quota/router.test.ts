import { describe, it, expect } from "vitest";
import { defaultConfig } from "../config/schema.js";
import { selectProducerModel, quotaGate } from "./router.js";
import { FIVE_HOUR_WINDOW_SECONDS, SEVEN_DAY_WINDOW_SECONDS } from "./window.js";
import type { UsageReading } from "./usage-source.js";

const CONFIG = defaultConfig();
const NOW = 1_700_000_000;

function underCurve(): UsageReading {
  return {
    kind: "available",
    fiveHour: { utilizationPct: 1, resetsAtEpoch: NOW + FIVE_HOUR_WINDOW_SECONDS },
    sevenDay: { utilizationPct: 1, resetsAtEpoch: NOW + SEVEN_DAY_WINDOW_SECONDS },
    capturedAt: NOW,
  };
}

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

describe("D25/D26 router — quotaGate carries NO review-depth/round axis", () => {
  it("on proceed returns the routed producer model and nothing review-related", () => {
    const r = quotaGate(underCurve(), "high", CONFIG, NOW);
    expect(r.kind).toBe("proceed");
    if (r.kind === "proceed") {
      expect(r.producerModel).toBe(CONFIG.quota.producerModels.high);
      // The deleted review-depth axis: no such key exists on the result.
      expect(Object.keys(r).sort()).toEqual(["kind", "producerModel"]);
      expect("reviewCap" in r).toBe(false);
      expect("reviewRounds" in r).toBe(false);
    }
  });
});

describe("D24 router — quotaGate stops (no model) on pause/suspend/halt", () => {
  it("5h over → stop with graceful-stop 5h and NO producer model", () => {
    const reading: UsageReading = {
      kind: "available",
      // hour 1 cap 20; push 5h over.
      fiveHour: { utilizationPct: 80, resetsAtEpoch: NOW + FIVE_HOUR_WINDOW_SECONDS },
      sevenDay: { utilizationPct: 1, resetsAtEpoch: NOW + SEVEN_DAY_WINDOW_SECONDS },
      capturedAt: NOW,
    };
    const r = quotaGate(reading, "low", CONFIG, NOW);
    expect(r.kind).toBe("stop");
    if (r.kind === "stop") {
      expect(r.stop.kind).toBe("graceful-stop");
      expect(r.stop.scope).toBe("5h");
      expect("producerModel" in r).toBe(false);
    }
  });

  it("unavailable reading → stop (7d-shaped graceful-stop), never a model", () => {
    const r = quotaGate(
      { kind: "unavailable", reason: "usage-cache-missing" },
      "high",
      CONFIG,
      NOW,
    );
    expect(r.kind).toBe("stop");
    if (r.kind === "stop") {
      expect(r.stop.scope).toBe("7d");
    }
  });
});
