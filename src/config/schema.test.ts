import { describe, it, expect } from "vitest";
import { ConfigSchema, defaultConfig } from "./schema.js";

describe("ConfigSchema", () => {
  it("an empty object parses to a fully-defaulted config", () => {
    const cfg = ConfigSchema.parse({});
    // Quality defaults (from the bash gate scripts).
    expect(cfg.quality.holdoutPercent).toBe(20);
    expect(cfg.quality.holdoutPassRate).toBe(80);
    expect(cfg.quality.mutationScoreTarget).toBe(80);
    expect(cfg.quality.coverageRegressionTolerancePct).toBe(0.5);
    expect(cfg.quality.securityRedactFindings).toBe(true);
    // Quota defaults (verbatim from pipeline-lib.sh).
    expect(cfg.quota.sleepCapSec).toBe(540);
    expect(cfg.quota.maxWaitCycles).toBe(60);
    expect(cfg.quota.maxStaleCycles).toBe(6);
    expect(cfg.quota.wallBudgetMin).toBe(75);
    expect(cfg.quota.hourlyThresholds).toEqual([20, 40, 60, 80, 90]);
    expect(cfg.quota.dailyThresholds).toEqual([14, 29, 43, 57, 71, 86, 95]);
    // Top-level.
    expect(cfg.maxConsecutiveFailures).toBe(3);
    expect(cfg.observability.auditLog).toBe(true);
  });

  it("defaultConfig() equals parsing {}", () => {
    expect(defaultConfig()).toEqual(ConfigSchema.parse({}));
  });

  it("quality.setupCommand is optional and round-trips when set", () => {
    expect(ConfigSchema.parse({}).quality.setupCommand).toBeUndefined();
    const cfg = ConfigSchema.parse({ quality: { setupCommand: "pnpm install --frozen-lockfile" } });
    expect(cfg.quality.setupCommand).toBe("pnpm install --frozen-lockfile");
  });

  it("merges partial overrides while defaulting the rest", () => {
    const cfg = ConfigSchema.parse({ quality: { holdoutPercent: 35 } });
    expect(cfg.quality.holdoutPercent).toBe(35);
    // sibling keys still default
    expect(cfg.quality.holdoutPassRate).toBe(80);
    // other blocks still default
    expect(cfg.quota.sleepCapSec).toBe(540);
  });

  it("rejects out-of-range values (loud, not silent)", () => {
    expect(() => ConfigSchema.parse({ quality: { holdoutPercent: 150 } })).toThrow();
    expect(() => ConfigSchema.parse({ quota: { sleepCapSec: -1 } })).toThrow();
  });

  it("rejects a wrong-length threshold curve", () => {
    expect(() => ConfigSchema.parse({ quota: { hourlyThresholds: [1, 2, 3] } })).toThrow();
  });

  it("does NOT carry forward retired human-gate keys", () => {
    const cfg = ConfigSchema.parse({});
    expect("humanReviewLevel" in cfg).toBe(false);
    // Zod strips unknown keys by default, so an injected retired key is dropped.
    const injected = ConfigSchema.parse({ humanReviewLevel: 2 } as Record<string, unknown>);
    expect("humanReviewLevel" in injected).toBe(false);
  });
});
