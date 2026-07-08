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
import {z} from 'zod'
import {at} from '../shared/index.js'

/**
 * The closed Agent effort/reasoning domain (weakest→strongest). THE one home for
 * the effort enum: the spawn request (`AgentSpecSchema.effort`) and the producer
 * dial's effort ladder (`model-dial.ts`) reuse it, so an out-of-domain effort is
 * rejected at the boundary instead of flowing through as an open string. Mirrors
 * `RiskTierEnum`.
 */
export const EffortEnum = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type Effort = z.infer<typeof EffortEnum>

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
        gateEnv: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'valid POSIX env name'), z.string()).default({}),
    })
    .default({})

/** A utilization curve must never step down — a later checkpoint below an earlier one would un-spend budget. */
function nonDecreasing(xs: readonly number[]): boolean {
    return xs.every((x, i) => i === 0 || x >= at(xs, i - 1))
}

/**
 * Two-window quota pacer config (WS4 owns). `hourlyThresholds` is the 5h curve
 * (per window-hour); `dailyThresholds` the 7d curve (per window-day). The 7d window
 * is rolling (not calendar-aligned): "window-day N" is a position in the rolling
 * window, not a weekday. The default ramps to 95% by day 5 then plateaus, giving a
 * 5-workday spend pattern with a 5% end-of-window reserve.
 */
export const QuotaSchema = z
    .object({
        /** 5h-window utilization checkpoints by hour 1..5 (% caps, non-decreasing). */
        hourlyThresholds: z
            .array(z.number().min(0).max(100))
            .length(5)
            .refine(nonDecreasing, {message: 'thresholds must be non-decreasing'})
            .default([20, 40, 60, 80, 90]),
        /** 7d-window utilization checkpoints by day 1..7 (% caps, non-decreasing). Ramps to 95% by day 5, plateaus through days 6–7 (5% end-of-window reserve). */
        dailyThresholds: z
            .array(z.number().min(0).max(100))
            .length(7)
            .refine(nonDecreasing, {message: 'thresholds must be non-decreasing'})
            .default([20, 40, 60, 80, 95, 95, 95]),
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
                low: z.string().default('claude-sonnet-4-5'),
                medium: z.string().default('claude-sonnet-4-5'),
                high: z.string().default('claude-opus-4-6'),
            })
            .default({}),
    })
    .default({})

/**
 * Spec-pipeline config (WS5). Migrated here from the staged `src/spec/config-
 * defaults.ts` per the seam contract ("ALL config defaults live in this file").
 *
 * Every key is operator-tunable; the WS10 orchestrator threads them off the
 * resolved config into the spec pipeline. The Decision-21 apex pin (spec
 * generator + reviewer model/effort) is deliberately NOT here — it is invariant
 * by construction, hard consts in `src/spec/agents.ts`.
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
        /** Max bytes of PRD body retained from `gh issue view` before truncation. */
        prdBodyMaxBytes: z
            .number()
            .int()
            .positive()
            .default(64 * 1024),
    })
    .default({})

/** Fully-resolved spec config (all defaults applied). */
export type SpecConfig = z.infer<typeof SpecSchema>

/**
 * The frozen spec defaults — the fallback the WS5 pipeline functions use when
 * the orchestrator passes no override.
 */
export const SPEC_DEFAULTS: Readonly<SpecConfig> = Object.freeze(SpecSchema.parse({}))

/** Judgment-panel reviewer config (WS7 extends). */
export const ReviewSchema = z
    .object({
        /** Reviewer model id (panel runs on a fixed model per Decision 26). */
        model: z.string().optional(),
        /** Max turns for a deep review pass. */
        maxTurnsDeep: z.number().int().positive().default(40),
        /** Max turns for a quick review pass. */
        maxTurnsQuick: z.number().int().positive().default(20),
        /**
         * Policy when NO cross-vendor (Codex) reviewer is available (S5/C):
         * `warn` records the absence loudly (task state + report + summary);
         * `block` additionally fails the merge gate — a task cannot ship without an
         * independent second-vendor review.
         */
        requireCrossVendor: z.enum(['warn', 'block']).default('warn'),
    })
    .default({})

/** Test-writer agent config (WS8 extends). */
export const TestWriterSchema = z
    .object({
        maxTurns: z.number().int().positive().default(30),
    })
    .default({})

/** Codex cross-vendor executor config (WS7/WS8). */
export const CodexSchema = z
    .object({
        model: z.string().optional(),
    })
    .default({})

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
        baseBranch: z.string().min(1).default('develop'),
        /** The integration branch task PRs serial-merge into (Δ L, §9.2). */
        stagingBranch: z.string().min(1).default('staging'),
        /**
         * Required status-check contexts branch protection MUST enforce on DEVELOP
         * (asserted at scaffold; provisioned with `--provision`). Defaults to the
         * three contexts the rendered quality-gate workflow always reports
         * (Decision 53) — the rollup PR cannot merge red. Protection itself
         * (incl. strict-up-to-date) is mandatory regardless; see
         * `requireProtectionOrRefuse`.
         */
        developRequiredStatusChecks: z.array(z.string()).default(['Quality', 'Mutation Testing', 'Security Scan']),
        /**
         * Required status-check contexts provisioned onto each per-run
         * `staging-<run-id>` branch at run create. Default EMPTY: the engine's
         * local GateRunner is the primary task-level enforcement, and a required
         * check here would make every task-PR merge wait on CI wall-clock.
         */
        stagingRequiredStatusChecks: z.array(z.string()).default([]),
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
        branchPrefix: z.string().min(1).default('factory'),
    })
    .default({})

/**
 * Playwright e2e config (Decision 39/40). All optional/defaulted so a repo that
 * never passes `--e2e` pays nothing. `startCommand`/`baseURL` are OPTIONAL OVERRIDES
 * (Decision 40 D10): the run-start assessment resolves the real boot pair itself and
 * writes it into the repo's `playwright.config.ts`; a value set here wins over the
 * assessment's (`resolveBootConfig` in `src/orchestrator/e2e.ts`). The runner module
 * actually reads every key below — no declared-but-never-load-bearing keys (the
 * `redTestCommand` cautionary tale — declared for years, read by nothing, pruned
 * in S7/Decision 46 — must NOT repeat here).
 */
export const E2eConfigSchema = z
    .object({
        /**
         * OPTIONAL override (Decision 40 D10) of the command that boots the target app,
         * for both Playwright's `webServer` (test runs) and the e2e-author's
         * live-exploration boot. Normally unset — the run-start assessment resolves it.
         */
        startCommand: z.string().optional(),
        /** OPTIONAL override of the base URL the app serves once booted (D10 — normally
         * assessment-resolved). */
        baseURL: z.string().url().optional(),
        /**
         * Repo-relative directory the COMMITTED critical suite lives in. Persistence
         * in this directory IS the criticality signal (Decision 39) — no `@critical`
         * tag exists. Locked to the default: the scaffolded `templates/playwright.config.ts`
         * hardcodes `e2e/` — a custom value here would silently diverge from what the
         * template actually runs, rather than genuinely relocating the suite (see the
         * superRefine below).
         */
        testDir: z.string().min(1).default('e2e'),
        /** Max wait for `startCommand` to become ready before the boot is a failure, ms. */
        readyTimeoutMs: z.number().int().positive().default(30_000),
        /**
         * Per-task cap on e2e-triggered reopens (Decision 39). A critical spec still
         * red after this many reopens of its mapped task fails the run outright
         * instead of looping forever.
         */
        reopenCap: z.number().int().nonnegative().default(2),
    })
    .superRefine((cfg, ctx) => {
        if (cfg.testDir !== 'e2e') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['testDir'],
                message:
                    `e2e.testDir must be the default 'e2e' — the scaffolded playwright.config.ts ` +
                    `hardcodes that path, so a custom value here would silently diverge from what ` +
                    'actually runs',
            })
        }
    })
    .default({})

/** Fully-resolved e2e config (all defaults applied). */
export type E2eConfig = z.infer<typeof E2eConfigSchema>

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
        e2e: E2eConfigSchema,
        /**
         * FLOOR of the circuit-breaker threshold: the run aborts when cumulative genuine
         * capability-budget failures reach `max(this, ceil(0.15 × total tasks))` — big
         * task graphs tolerate proportionally more (≤20 tasks behave as a flat cap of 3).
         * The signal is run-cumulative, not strictly consecutive (the breaker gate counts
         * total capability-budget drops); the field keeps its name for config back-compat.
         */
        maxConsecutiveFailures: z.number().int().positive().default(3),
        /**
         * How many tasks the runner may have in flight at once. Surfaced to the
         * runner on the `kind:"work"` envelope as `max_parallel` (the runner reads
         * the envelope, never this file). Min 1 (1 = sequential, today's behavior).
         */
        maxParallelTasks: z.number().int().positive().default(3),
        /**
         * Minutes an in-flight spawn (`task.spawn_in_flight.spawned_at`) may age
         * before `next-task` flags it in `work.stale` (advisory — a hung agent that
         * died silently is never re-driven inside a live session otherwise). Default
         * 20: stalls are the #1 operational pain (design-review-2026-07-07).
         */
        stallTtlMinutes: z.number().int().positive().default(20),
    })
    .default({})

/** Fully-resolved, typed config (all defaults applied). */
export type Config = z.infer<typeof ConfigSchema>

/** Convenience: the default config (equivalent to `ConfigSchema.parse({})`). */
export function defaultConfig(): Config {
    return ConfigSchema.parse({})
}
