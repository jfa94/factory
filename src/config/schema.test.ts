import {describe, it, expect} from 'vitest'
import {ConfigSchema, defaultConfig} from './schema.js'

describe('ConfigSchema', () => {
    it('an empty object parses to a fully-defaulted config', () => {
        const cfg = ConfigSchema.parse({})
        // Quality defaults (from the bash gate scripts).
        expect(cfg.quality.mutationScoreTarget).toBe(80)
        expect(cfg.quality.coverageRegressionTolerancePct).toBe(0.5)
        expect(cfg.quality.securityRedactFindings).toBe(true)
        // Quota defaults.
        expect(cfg.quota.hourlyThresholds).toEqual([20, 40, 60, 80, 90])
        expect(cfg.quota.dailyThresholds).toEqual([20, 40, 60, 80, 95, 95, 95])
        // A6: rollup CI wait budget (minutes) — sized above a cold-cache mutation run.
        expect(cfg.git.rollupCiWaitMinutes).toBe(30)
    })

    it('git.rollupCiWaitMinutes accepts a positive int, rejects zero/negative/fractional', () => {
        expect(ConfigSchema.parse({git: {rollupCiWaitMinutes: 45}}).git.rollupCiWaitMinutes).toBe(45)
        expect(() => ConfigSchema.parse({git: {rollupCiWaitMinutes: 0}})).toThrow()
        expect(() => ConfigSchema.parse({git: {rollupCiWaitMinutes: -5}})).toThrow()
        expect(() => ConfigSchema.parse({git: {rollupCiWaitMinutes: 1.5}})).toThrow()
    })

    it('stale overlay keys (pruned config fields) are stripped, not fatal', () => {
        // Regression guard: an on-disk config written by an older plugin version may
        // still carry pruned keys; ConfigSchema must strip them and keep loading.
        const cfg = ConfigSchema.parse({
            maxRuntimeMinutes: 480,
            quota: {maxStaleCycles: 6},
            e2e: {enabled: true},
            spec: {specModel: 'opus', specEffort: 'max'},
            quality: {redTestCommand: 'go test ./...'},
        })
        expect(cfg).toEqual(defaultConfig())
    })

    it('a config carrying the keys retired with v1 still loads to the defaults', () => {
        const cfg = ConfigSchema.parse({
            quality: {holdoutPercent: 25, holdoutPassRate: 90},
            quota: {producerModels: {low: 'haiku'}},
            review: {model: 'opus', requireCrossVendor: 'block'},
            codex: {model: 'gpt'},
            git: {
                stagingRequiredStatusChecks: ['CI'],
                provision: true,
                branchPrefix: 'bot',
                developProtection: 'permanent',
            },
            e2e: {startCommand: 'npm start', reopenCap: 1},
            maxConsecutiveFailures: 5,
            maxParallelTasks: 2,
            stallTtlMinutes: 30,
            hungSpawnMinutes: 10,
        })
        expect(cfg).toEqual(defaultConfig())
    })

    it('defaultConfig() equals parsing {}', () => {
        expect(defaultConfig()).toEqual(ConfigSchema.parse({}))
    })

    it('git.developBaselineStatusChecks derives from developRequiredStatusChecks minus Mutation Testing (D74)', () => {
        // Default run profile → derived baseline Quality + Security Scan.
        expect(ConfigSchema.parse({}).git.developBaselineStatusChecks).toEqual(['Quality', 'Security Scan'])
        // A custom run-profile context (e.g. a repo's pgTAP check) carries into the baseline.
        const custom = ConfigSchema.parse({
            git: {developRequiredStatusChecks: ['Quality', 'Mutation Testing', 'Security Scan', 'Database Tests']},
        })
        expect(custom.git.developBaselineStatusChecks).toEqual(['Quality', 'Security Scan', 'Database Tests'])
        // An explicit value (including []) overrides the derivation.
        expect(ConfigSchema.parse({git: {developBaselineStatusChecks: []}}).git.developBaselineStatusChecks).toEqual([])
        const explicit = ConfigSchema.parse({
            git: {
                developRequiredStatusChecks: ['Quality', 'Mutation Testing', 'Security Scan', 'Database Tests'],
                developBaselineStatusChecks: ['Quality'],
            },
        })
        expect(explicit.git.developBaselineStatusChecks).toEqual(['Quality'])
    })

    it('quality.setupCommand is optional and round-trips when set', () => {
        expect(ConfigSchema.parse({}).quality.setupCommand).toBeUndefined()
        const cfg = ConfigSchema.parse({quality: {setupCommand: 'pnpm install --frozen-lockfile'}})
        expect(cfg.quality.setupCommand).toBe('pnpm install --frozen-lockfile')
    })

    it('quality.gateEnv defaults to {} and round-trips a string map', () => {
        expect(ConfigSchema.parse({}).quality.gateEnv).toEqual({})
        const cfg = ConfigSchema.parse({
            quality: {
                gateEnv: {
                    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
                    NEXT_PUBLIC_SUPABASE_KEY: 'ci-placeholder',
                },
            },
        })
        expect(cfg.quality.gateEnv).toEqual({
            NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
            NEXT_PUBLIC_SUPABASE_KEY: 'ci-placeholder',
        })
    })

    it('quality.gateEnv rejects a non-string value (loud, not silently coerced)', () => {
        expect(() => ConfigSchema.parse({quality: {gateEnv: {PORT: 54321}}})).toThrow()
    })

    it('quality.gateEnv rejects a non-POSIX key name (the --set boundary guard)', () => {
        expect(() => ConfigSchema.parse({quality: {gateEnv: {'bad-key': 'x'}}})).toThrow()
        expect(() => ConfigSchema.parse({quality: {gateEnv: {'foo.bar': 'x'}}})).toThrow()
        // A valid POSIX name still round-trips.
        expect(ConfigSchema.parse({quality: {gateEnv: {OK_NAME: 'x'}}}).quality.gateEnv).toEqual({
            OK_NAME: 'x',
        })
    })

    it('merges partial overrides while defaulting the rest', () => {
        const cfg = ConfigSchema.parse({quality: {mutationScoreTarget: 35}})
        expect(cfg.quality.mutationScoreTarget).toBe(35)
        // sibling keys still default
        expect(cfg.quality.coverageRegressionTolerancePct).toBe(0.5)
        // other blocks still default
        expect(cfg.quota.hourlyThresholds).toEqual([20, 40, 60, 80, 90])
    })

    it('rejects out-of-range values (loud, not silent)', () => {
        expect(() => ConfigSchema.parse({quality: {mutationScoreTarget: 150}})).toThrow()
        expect(() => ConfigSchema.parse({quality: {coverageRegressionTolerancePct: -1}})).toThrow()
    })

    it('rejects a wrong-length threshold curve', () => {
        expect(() => ConfigSchema.parse({quota: {hourlyThresholds: [1, 2, 3]}})).toThrow()
    })

    it('rejects out-of-range threshold elements (percent caps: 0..100)', () => {
        expect(() => ConfigSchema.parse({quota: {hourlyThresholds: [20, 40, 60, 80, 101]}})).toThrow()
        expect(() => ConfigSchema.parse({quota: {dailyThresholds: [-1, 40, 60, 80, 95, 95, 95]}})).toThrow()
    })

    it('rejects a decreasing threshold curve (utilization caps never step down)', () => {
        expect(() => ConfigSchema.parse({quota: {hourlyThresholds: [20, 40, 30, 80, 90]}})).toThrow(/non-decreasing/)
        expect(() => ConfigSchema.parse({quota: {dailyThresholds: [20, 40, 60, 80, 95, 95, 90]}})).toThrow(
            /non-decreasing/
        )
        // A plateau (equal neighbours) is fine — the default daily curve has one.
        expect(ConfigSchema.parse({quota: {hourlyThresholds: [20, 20, 60, 80, 90]}}).quota.hourlyThresholds).toEqual([
            20, 20, 60, 80, 90,
        ])
    })

    it('does NOT carry forward retired human-gate keys', () => {
        const cfg = ConfigSchema.parse({})
        expect('humanReviewLevel' in cfg).toBe(false)
        // Zod strips unknown keys by default, so an injected retired key is dropped.
        const injected = ConfigSchema.parse({humanReviewLevel: 2})
        expect('humanReviewLevel' in injected).toBe(false)
    })
})
