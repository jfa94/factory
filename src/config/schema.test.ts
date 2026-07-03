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
    expect(cfg.quota.wallBudgetMin).toBe(75);
    expect(cfg.quota.hourlyThresholds).toEqual([20, 40, 60, 80, 90]);
    expect(cfg.quota.dailyThresholds).toEqual([20, 40, 60, 80, 95, 95, 95]);
    // Top-level.
    expect(cfg.maxConsecutiveFailures).toBe(3);
    expect(cfg.maxParallelTasks).toBe(3);
  });

  it("stale overlay keys (pruned config fields) are stripped, not fatal", () => {
    // Regression guard: an on-disk config written by an older plugin version may
    // still carry pruned keys; ConfigSchema must strip them and keep loading.
    const cfg = ConfigSchema.parse({
      maxRuntimeMinutes: 480,
      quota: { maxStaleCycles: 6 },
    });
    expect(cfg).toEqual(defaultConfig());
  });

  it("defaultConfig() equals parsing {}", () => {
    expect(defaultConfig()).toEqual(ConfigSchema.parse({}));
  });

  it("review.requireCrossVendor defaults to warn, accepts block, rejects anything else (S5/C)", () => {
    expect(ConfigSchema.parse({}).review.requireCrossVendor).toBe("warn");
    expect(
      ConfigSchema.parse({ review: { requireCrossVendor: "block" } }).review.requireCrossVendor,
    ).toBe("block");
    expect(() => ConfigSchema.parse({ review: { requireCrossVendor: "off" } })).toThrow();
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
    // maxParallelTasks: min 1 (N4) — 0 and negatives reject.
    expect(() => ConfigSchema.parse({ maxParallelTasks: 0 })).toThrow();
    expect(() => ConfigSchema.parse({ maxParallelTasks: -1 })).toThrow();
  });

  it("rejects a wrong-length threshold curve", () => {
    expect(() => ConfigSchema.parse({ quota: { hourlyThresholds: [1, 2, 3] } })).toThrow();
  });

  it("rejects out-of-range threshold elements (percent caps: 0..100)", () => {
    expect(() =>
      ConfigSchema.parse({ quota: { hourlyThresholds: [20, 40, 60, 80, 101] } }),
    ).toThrow();
    expect(() =>
      ConfigSchema.parse({ quota: { dailyThresholds: [-1, 40, 60, 80, 95, 95, 95] } }),
    ).toThrow();
  });

  it("rejects a decreasing threshold curve (utilization caps never step down)", () => {
    expect(() => ConfigSchema.parse({ quota: { hourlyThresholds: [20, 40, 30, 80, 90] } })).toThrow(
      /non-decreasing/,
    );
    expect(() =>
      ConfigSchema.parse({ quota: { dailyThresholds: [20, 40, 60, 80, 95, 95, 90] } }),
    ).toThrow(/non-decreasing/);
    // A plateau (equal neighbours) is fine — the default daily curve has one.
    expect(
      ConfigSchema.parse({ quota: { hourlyThresholds: [20, 20, 60, 80, 90] } }).quota
        .hourlyThresholds,
    ).toEqual([20, 20, 60, 80, 90]);
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

  describe("e2e (Decision 39 — Playwright config)", () => {
    it("defaults testDir, readyTimeoutMs, reopenCap; leaves startCommand/baseURL/enabled unset", () => {
      const cfg = ConfigSchema.parse({});
      expect(cfg.e2e.testDir).toBe("e2e");
      expect(cfg.e2e.readyTimeoutMs).toBe(30_000);
      expect(cfg.e2e.reopenCap).toBe(2);
      expect(cfg.e2e.enabled).toBeUndefined();
      expect(cfg.e2e.startCommand).toBeUndefined();
      expect(cfg.e2e.baseURL).toBeUndefined();
    });

    it("round-trips a fully-configured e2e block", () => {
      const cfg = ConfigSchema.parse({
        e2e: {
          enabled: true,
          startCommand: "npm run dev",
          baseURL: "http://localhost:3000",
          testDir: "e2e",
          readyTimeoutMs: 60_000,
          reopenCap: 1,
        },
      });
      expect(cfg.e2e).toEqual({
        enabled: true,
        startCommand: "npm run dev",
        baseURL: "http://localhost:3000",
        testDir: "e2e",
        readyTimeoutMs: 60_000,
        reopenCap: 1,
      });
    });

    it("merges a partial e2e override while defaulting siblings", () => {
      const cfg = ConfigSchema.parse({ e2e: { startCommand: "npm start" } });
      expect(cfg.e2e.startCommand).toBe("npm start");
      expect(cfg.e2e.testDir).toBe("e2e");
      expect(cfg.e2e.reopenCap).toBe(2);
    });

    it("rejects an empty testDir and a negative reopenCap (loud, not silent)", () => {
      expect(() => ConfigSchema.parse({ e2e: { testDir: "" } })).toThrow();
      expect(() => ConfigSchema.parse({ e2e: { reopenCap: -1 } })).toThrow();
    });

    it("rejects a non-default testDir — the scaffolded template and CI workflow hardcode 'e2e' today, so a custom value would silently diverge from what actually runs", () => {
      expect(() => ConfigSchema.parse({ e2e: { testDir: "tests/e2e" } })).toThrow();
    });

    it("rejects a non-URL baseURL (loud, not silent)", () => {
      expect(() => ConfigSchema.parse({ e2e: { baseURL: "not-a-url" } })).toThrow();
    });

    it("reopenCap accepts 0 (no reopen budget, still schema-valid)", () => {
      expect(ConfigSchema.parse({ e2e: { reopenCap: 0 } }).e2e.reopenCap).toBe(0);
    });
  });
});
