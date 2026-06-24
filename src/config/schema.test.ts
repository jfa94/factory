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
    expect(cfg.quota.dailyThresholds).toEqual([20, 40, 60, 80, 95, 95, 95]);
    // Top-level.
    expect(cfg.maxConsecutiveFailures).toBe(3);
    expect(cfg.maxRuntimeMinutes).toBe(480);
  });

  it("defaultConfig() equals parsing {}", () => {
    expect(defaultConfig()).toEqual(ConfigSchema.parse({}));
  });

  it("quality.setupCommand is optional and round-trips when set", () => {
    expect(ConfigSchema.parse({}).quality.setupCommand).toBeUndefined();
    const cfg = ConfigSchema.parse({ quality: { setupCommand: "pnpm install --frozen-lockfile" } });
    expect(cfg.quality.setupCommand).toBe("pnpm install --frozen-lockfile");
  });

  it("quality.gateEnv defaults to {} and round-trips a string map", () => {
    expect(ConfigSchema.parse({}).quality.gateEnv).toEqual({});
    const cfg = ConfigSchema.parse({
      quality: {
        gateEnv: {
          NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
          NEXT_PUBLIC_SUPABASE_KEY: "ci-placeholder",
        },
      },
    });
    expect(cfg.quality.gateEnv).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      NEXT_PUBLIC_SUPABASE_KEY: "ci-placeholder",
    });
  });

  it("quality.gateEnv rejects a non-string value (loud, not silently coerced)", () => {
    expect(() => ConfigSchema.parse({ quality: { gateEnv: { PORT: 54321 } } })).toThrow();
  });

  it("quality.gateEnv rejects a non-POSIX key name (the --set boundary guard)", () => {
    expect(() => ConfigSchema.parse({ quality: { gateEnv: { "bad-key": "x" } } })).toThrow();
    expect(() => ConfigSchema.parse({ quality: { gateEnv: { "foo.bar": "x" } } })).toThrow();
    // A valid POSIX name still round-trips.
    expect(ConfigSchema.parse({ quality: { gateEnv: { OK_NAME: "x" } } }).quality.gateEnv).toEqual({
      OK_NAME: "x",
    });
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

  it("spec.specEffort defaults to 'max' and is a CLOSED enum (out-of-domain rejected loud)", () => {
    expect(ConfigSchema.parse({}).spec.specEffort).toBe("max");
    // An in-domain effort round-trips.
    expect(ConfigSchema.parse({ spec: { specEffort: "high" } }).spec.specEffort).toBe("high");
    // An out-of-domain effort is rejected, not silently coerced to a string.
    expect(() => ConfigSchema.parse({ spec: { specEffort: "turbo" } })).toThrow();
  });

  it("does NOT carry forward retired human-gate keys", () => {
    const cfg = ConfigSchema.parse({});
    expect("humanReviewLevel" in cfg).toBe(false);
    // Zod strips unknown keys by default, so an injected retired key is dropped.
    const injected = ConfigSchema.parse({ humanReviewLevel: 2 } as Record<string, unknown>);
    expect("humanReviewLevel" in injected).toBe(false);
  });
});
