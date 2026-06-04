/**
 * THE canonical config schema and defaults home — frozen seam.
 *
 * This is the ONE place every config default lives (Decision: "one Zod schema
 * with ALL defaults centralized"). It kills the scattered-`read_config`-drift
 * the bash code suffered, where the same key had different defaults at different
 * call sites.
 *
 * WS0 seeds the real keys harvested from the bash `read_config` audit so
 * downstream workstreams EXTEND their slice here rather than re-inventing keys.
 * The seam contract is "all defaults live in this file" — NOT "every key is
 * final in WS0". WS1/WS4/WS5/WS6 each add their own keys to the relevant
 * sub-schema.
 *
 * RETIRED keys (locked decision 5 — human gates removed) are deliberately
 * ABSENT and must NOT be carried forward: `humanReviewLevel`, `NEEDS_DISCUSSION`,
 * exit-42. The old `execution.*` block is superseded by the unified producer
 * dial (WS5/WS8) and is intentionally not ported here.
 *
 * Every field uses `.default(...)`, so `ConfigSchema.parse({})` yields a fully
 * populated, typed config with no missing keys.
 */
import { z } from "zod";

/** Quality gate thresholds (WS6 extends). Defaults from the bash gate scripts. */
export const QualitySchema = z
  .object({
    /** Percent of acceptance criteria held out as an unreadable answer-key. */
    holdoutPercent: z.number().min(0).max(100).default(20),
    /** Min pass-rate (%) on the holdout set to clear the gate. */
    holdoutPassRate: z.number().min(0).max(100).default(80),
    /** Target mutation score (%) for the mutation gate. */
    mutationScoreTarget: z.number().min(0).max(100).default(80),
    /** Allowed coverage regression (percentage points) before the gate fails. */
    coverageRegressionTolerancePct: z.number().min(0).default(0.5),
    /** Optional custom SAST/security command (else the built-in semgrep run). */
    securityCommand: z.string().optional(),
    /** Treat security findings as non-blocking when true. */
    securityAllowFailures: z.boolean().default(false),
    /** Redact secrets from the persisted findings artifact (on by default). */
    securityRedactFindings: z.boolean().default(true),
    /**
     * Custom "red test" verification command for exotic runners (Go, Ruby,
     * Deno, …) so TDD enforcement need not be bypassed. Optional.
     */
    redTestCommand: z.string().optional(),
  })
  .default({});

/**
 * Two-window quota pacer config (WS4 owns). Defaults lifted verbatim from
 * `bin/pipeline-lib.sh`. `hourlyThresholds` is the 5h curve (per window-hour),
 * `dailyThresholds` the 7d curve (per window-day).
 */
export const QuotaSchema = z
  .object({
    /** Max single sleep chunk per gate call, seconds. */
    sleepCapSec: z.number().int().positive().default(540),
    /** Max wait cycles before the gate ends a wait, count. */
    maxWaitCycles: z.number().int().positive().default(60),
    /** Max consecutive stale-cache cycles before graceful end, count. */
    maxStaleCycles: z.number().int().positive().default(6),
    /** Accumulated wall-clock wait budget across cycles, minutes. */
    wallBudgetMin: z.number().int().positive().default(75),
    /** 5h-window utilization checkpoints by hour 1..5 (% caps). */
    hourlyThresholds: z.array(z.number()).length(5).default([20, 40, 60, 80, 90]),
    /** 7d-window utilization checkpoints by day 1..7 (% caps). */
    dailyThresholds: z.array(z.number()).length(7).default([14, 29, 43, 57, 71, 86, 95]),
  })
  .default({});

/** Judgment-panel reviewer config (WS7 extends). */
export const ReviewSchema = z
  .object({
    /** Reviewer model id (panel runs on a fixed model per Decision 26). */
    model: z.string().optional(),
    /** Max turns for a deep review pass. */
    maxTurnsDeep: z.number().int().positive().default(40),
    /** Max turns for a quick review pass. */
    maxTurnsQuick: z.number().int().positive().default(20),
  })
  .default({});

/** Test-writer agent config (WS8 extends). */
export const TestWriterSchema = z
  .object({
    maxTurns: z.number().int().positive().default(30),
  })
  .default({});

/** Scribe (docs) agent config (WS10/WS12). */
export const ScribeSchema = z
  .object({
    maxTurns: z.number().int().positive().default(20),
  })
  .default({});

/** Codex cross-vendor executor config (WS7/WS8). */
export const CodexSchema = z
  .object({
    model: z.string().optional(),
  })
  .default({});

/** Observability / telemetry config (WS12). */
export const ObservabilitySchema = z
  .object({
    /** Emit the jsonl audit log. */
    auditLog: z.boolean().default(true),
    /** Days to retain metrics before pruning. */
    metricsRetentionDays: z.number().int().positive().default(30),
  })
  .default({});

/** Cross-task dependency / PR-merge polling config (WS3). */
export const DependenciesSchema = z
  .object({
    /** Poll interval while waiting on a dependency PR, seconds. */
    pollInterval: z.number().int().positive().default(30),
    /** Timeout waiting for a PR to merge, seconds. */
    prMergeTimeout: z.number().int().positive().default(1800),
  })
  .default({});

/**
 * The single root config schema. Every sub-block defaults, so an empty object
 * (or a missing config file) parses to a complete config.
 */
export const ConfigSchema = z
  .object({
    quality: QualitySchema,
    quota: QuotaSchema,
    review: ReviewSchema,
    testWriter: TestWriterSchema,
    scribe: ScribeSchema,
    codex: CodexSchema,
    observability: ObservabilitySchema,
    dependencies: DependenciesSchema,
    /** Consecutive task failures before the run aborts. */
    maxConsecutiveFailures: z.number().int().positive().default(3),
    /** Hard wall-clock cap for a whole run, minutes. */
    maxRuntimeMinutes: z.number().int().positive().default(480),
  })
  .default({});

/** Fully-resolved, typed config (all defaults applied). */
export type Config = z.infer<typeof ConfigSchema>;

/** Convenience: the default config (equivalent to `ConfigSchema.parse({})`). */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}
