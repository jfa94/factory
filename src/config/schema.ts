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

/**
 * Git / PR I/O config (WS3 owns). Centralizes the base branch and the
 * required-status-checks contract the run refuses to start without (#2 / Δ A).
 *
 * Per the seam contract ("all defaults live in this file; WS_ extend their
 * slice"), WS3 adds this sub-schema rather than scattering branch/protection
 * literals across src/git.
 */
export const GitSchema = z
    .object({
        /**
         * The feature PR's base branch. Unset resolves at use (decision 8, see
         * `git/base-branch.ts`): `develop` if the remote has it, else the remote HEAD.
         */
        baseBranch: z.string().min(1).optional(),
        /**
         * Extra PR target branches for the rendered quality-gate workflow only (e.g. a
         * repo that also gates release PRs into `main`). The base branch is always included.
         * GitHub glob patterns (`release/*`) pass through; negation (`!x`) is rejected.
         */
        qualityGateExtraBranches: z
            .array(
                z
                    .string()
                    .regex(
                        /^[^!\s]\S*$/,
                        'qualityGateExtraBranches: branch names must not start with ! or contain whitespace'
                    )
            )
            .default([]),
        /**
         * Required status-check contexts of the resolved base branch's protection
         * profile, asserted by scaffold and run preflight and provisioned with `--provision`.
         * Defaults to the three contexts the rendered quality-gate workflow
         * always reports (Decision 53) — the rollup PR cannot merge red.
         */
        developRequiredStatusChecks: z.array(z.string()).default(['Quality', 'Mutation Testing', 'Security Scan']),
        /**
         * Outer bound (minutes) finalize waits for the rollup PR's full-CI gate
         * before giving up with `ci-timeout`. Sized above the slowest expected
         * quality-gate run (mutation on a cold cache); a timeout still parks the
         * run recoverably (`factory resume` re-enters the poll).
         */
        rollupCiWaitMinutes: z.number().int().positive().default(30),
    })
    .default({})

/**
 * The single root config schema. Every sub-block defaults, so an empty object
 * (or a missing config file) parses to a complete config.
 */
export const ConfigSchema = z
    .object({
        quality: QualitySchema,
        quota: QuotaSchema,
        spec: SpecSchema,
        git: GitSchema,
    })
    .default({})

/** Fully-resolved, typed config (all defaults applied). */
export type Config = z.infer<typeof ConfigSchema>

/** Convenience: the default config (equivalent to `ConfigSchema.parse({})`). */
export function defaultConfig(): Config {
    return ConfigSchema.parse({})
}
