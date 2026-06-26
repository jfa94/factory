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

/**
 * The closed Agent effort/reasoning domain (weakest→strongest). THE one home for
 * the effort enum: the Decision-21 apex pin ({@link SpecSchema}'s `specEffort`),
 * the spawn request (`AgentSpecSchema.effort`), and the producer dial's effort
 * ladder (`model-dial.ts`) all reuse it, so an out-of-domain effort is rejected at
 * the boundary instead of flowing through as an open string. Mirrors `RiskTierEnum`.
 */
export const EffortEnum = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortEnum>;

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
    /**
     * Per-worktree environment-prep command run once after the task worktree is
     * created, BEFORE the deterministic command-gates (test/type/build). When
     * unset, a lockfile in the worktree is auto-detected (`package-lock.json` →
     * `npm ci`, `pnpm-lock.yaml`/`yarn.lock` → frozen install); a repo with no
     * lockfile is a no-op. Set this for non-JS repos or custom setups. Optional.
     */
    setupCommand: z.string().optional(),
    /**
     * Env vars injected into EVERY deterministic gate command (build/test/type/
     * lint/security), merged over `process.env`. Mirror the repo's CI build-step
     * env (e.g. the placeholders a Next.js static prerender needs) so the verifier
     * floor measures the code, not a missing-env build crash. Placeholders only —
     * NOT a secret store. Values are required strings (an explicit "set this var");
     * a numeric-looking value must be quoted as JSON at the `--set` boundary.
     */
    gateEnv: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "valid POSIX env name"), z.string())
      .default({}),
  })
  .default({});

/**
 * Two-window quota pacer config (WS4 owns). `hourlyThresholds` is the 5h curve
 * (per window-hour); `dailyThresholds` the 7d curve (per window-day). The 7d window
 * is rolling (not calendar-aligned): "window-day N" is a position in the rolling
 * window, not a weekday. The default ramps to 95% by day 5 then plateaus, giving a
 * 5-workday spend pattern with a 5% end-of-window reserve.
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
    /** 7d-window utilization checkpoints by day 1..7 (% caps). Ramps to 95% by day 5, plateaus through days 6–7 (5% end-of-window reserve). */
    dailyThresholds: z.array(z.number()).length(7).default([20, 40, 60, 80, 95, 95, 95]),
    /**
     * Producer-model dial keyed by risk tier (Decision 25). The quota-router (the
     * renamed model-router, narrowed) selects the producer model for a task from
     * its risk tier; this is the ONLY dial it carries — the review panel is
     * risk-INVARIANT (Decision 25/26), so there is NO review-depth/round cap here
     * (the old `--tier` routine/feature/security review caps are DELETED).
     * Defaults: low/medium→sonnet (balanced), high→opus (strong). low defaults to
     * SONNET, not haiku — even low-risk work is code generation, which haiku
     * underperforms; override `producerModels.low` per-repo for cheaper low-risk runs.
     */
    producerModels: z
      .object({
        low: z.string().default("claude-sonnet-4-5"),
        medium: z.string().default("claude-sonnet-4-5"),
        high: z.string().default("claude-opus-4-6"),
      })
      .default({}),
  })
  .default({});

/**
 * Spec-pipeline config (WS5). Migrated here from the staged `src/spec/config-
 * defaults.ts` per the seam contract ("ALL config defaults live in this file").
 *
 * `specModel`/`specEffort` are the Decision-21 apex pin: the spec generator AND
 * reviewer run UNCONDITIONALLY at this model/effort. They are surfaced as defaults
 * (so the value has ONE home) but the apex boundary (`src/spec/agents.ts`) reads
 * the frozen {@link SPEC_DEFAULTS}, never a per-run override — the pin is invariant
 * by construction. The remaining keys (`passReviewThreshold`, `dimensionFloor`,
 * `maxRegenIterations`, `prdBodyMaxBytes`) ARE operator-tunable and the WS10 driver
 * threads them off the resolved config into the spec pipeline.
 */
export const SpecSchema = z
  .object({
    /**
     * The SINGLE spec-review pass threshold out of 60 (Δ I — resolves the legacy
     * 54-vs-56 conflict in favor of 56). `total >= passReviewThreshold` is a
     * candidate PASS, still subject to the per-dimension floor below.
     */
    passReviewThreshold: z.number().int().min(0).max(60).default(56),
    /**
     * Any-dimension auto-fail floor (Δ I): a single rubric dimension scoring
     * `<= dimensionFloor` forces NEEDS_REVISION regardless of the total.
     */
    dimensionFloor: z.number().int().min(0).max(10).default(5),
    /** Max spec generate→review revision iterations before a loud give-up. */
    maxRegenIterations: z.number().int().positive().default(5),
    /** Apex model the spec generator AND reviewer are pinned to (Decision 21). */
    specModel: z.string().min(1).default("opus"),
    /** Apex effort the spec generator AND reviewer are pinned to (Decision 21). */
    specEffort: EffortEnum.default("max"),
    /** Max bytes of PRD body retained from `gh issue view` before truncation. */
    prdBodyMaxBytes: z
      .number()
      .int()
      .positive()
      .default(64 * 1024),
  })
  .default({});

/** Fully-resolved spec config (all defaults applied). */
export type SpecConfig = z.infer<typeof SpecSchema>;

/**
 * The frozen spec defaults. The single source the apex boundary
 * (`src/spec/agents.ts`) reads for the unconditional Decision-21 pin, and the
 * fallback the WS5 pipeline functions use when the driver passes no override.
 */
export const SPEC_DEFAULTS: Readonly<SpecConfig> = Object.freeze(SpecSchema.parse({}));

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

/** Codex cross-vendor executor config (WS7/WS8). */
export const CodexSchema = z
  .object({
    model: z.string().optional(),
  })
  .default({});

/**
 * Git / PR I/O + serial-writer config (WS3 owns). Centralizes the base branch,
 * the integration branch, the required-status-checks contract the run refuses to
 * start without (#2 / Δ A), and whether protection provisioning is opted in.
 *
 * Per the seam contract ("all defaults live in this file; WS_ extend their
 * slice"), WS3 adds this sub-schema rather than scattering branch/protection
 * literals across src/git.
 */
export const GitSchema = z
  .object({
    /**
     * The durable base branch staging forks from and rolls up into. NEVER
     * `main` (Decision 12/16 — the factory never touches main; promotion to main
     * is human-owned and out of scope).
     */
    baseBranch: z.string().min(1).default("develop"),
    /** The integration branch task PRs serial-merge into (Δ L, §9.2). */
    stagingBranch: z.string().min(1).default("staging"),
    /**
     * Required status-check contexts that branch protection MUST enforce on the
     * staging branch before a run may start. Empty means "no specific checks
     * required" — but protection itself (incl. strict-up-to-date) is still
     * mandatory; see `requireProtectionOrRefuse`.
     */
    requiredStatusChecks: z.array(z.string()).default([]),
    /**
     * Opt-in protection provisioning. OFF by default — the run VERIFIES and
     * REFUSES when protection is missing (#2 / Δ A); only `--provision` flips
     * this to issue the `gh api` PUT.
     */
    provision: z.boolean().default(false),
    /**
     * Branch-name prefix for run-scoped task branches (Δ M). The full name is
     * `<branchPrefix>/<run_id>/<task_id>`.
     */
    branchPrefix: z.string().min(1).default("factory"),
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
    spec: SpecSchema,
    review: ReviewSchema,
    testWriter: TestWriterSchema,
    codex: CodexSchema,
    git: GitSchema,
    /**
     * Cumulative genuine capability-budget task failures before the run aborts.
     * The signal is run-cumulative, not strictly consecutive (the breaker gate counts
     * total capability-budget drops); the field keeps its name for config back-compat.
     */
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
