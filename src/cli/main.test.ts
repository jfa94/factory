import {describe, it, expect, vi, afterEach} from 'vitest'
import {dispatch, cliRegistry} from './main.js'
import {EXIT} from '../shared/exit-codes.js'

describe('cli dispatch', () => {
    afterEach(() => vi.restoreAllMocks())

    it('config-defaults returns OK and emits a parseable, well-shaped config', async () => {
        // NOTE: this asserts STRUCTURE, not exact values. `config-defaults` runs
        // loadConfig(), which reads any real <dataDir>/config.json present on the
        // host and merges it over the schema defaults — so concrete values are
        // machine-dependent. Pure-default value assertions live in schema.test.ts
        // (against ConfigSchema.parse({})). That this command picks up a live
        // override is itself the proof the loader works end-to-end.
        const chunks: string[] = []
        vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
            chunks.push(String(c))
            return true
        })

        const code = await dispatch(['config-defaults'])
        expect(code).toBe(EXIT.OK)

        interface ConfigDefaultsShape {
            quota: {
                hourlyThresholds: unknown[]
                dailyThresholds: unknown[]
            }
            spec: Record<string, unknown>
            e2e: Record<string, unknown>
        }
        const parsed = JSON.parse(chunks.join('')) as ConfigDefaultsShape
        // The full schema shape must be present (every block defaults).
        expect(parsed).toHaveProperty('quality.holdoutPercent')
        expect(Array.isArray(parsed.quota.hourlyThresholds)).toBe(true)
        expect(parsed.quota.hourlyThresholds).toHaveLength(5)
        expect(parsed.quota.dailyThresholds).toHaveLength(7)
        // Retired human-gate keys must never appear.
        expect(parsed).not.toHaveProperty('humanReviewLevel')
        // Pruned decorative keys (S6) must never appear.
        expect(parsed.spec).not.toHaveProperty('specModel')
        expect(parsed.spec).not.toHaveProperty('specEffort')
        expect(parsed.e2e).not.toHaveProperty('enabled')
    })

    it('--help returns OK', async () => {
        vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
        expect(await dispatch(['--help'])).toBe(EXIT.OK)
        expect(await dispatch([])).toBe(EXIT.OK)
    })

    it('unknown subcommand returns USAGE (2)', async () => {
        vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
        expect(await dispatch(['definitely-not-a-command'])).toBe(EXIT.USAGE)
    })

    it('registry is an extensible seam (downstream can register)', async () => {
        cliRegistry['__test-ext'] = {describe: 'test', run: () => EXIT.OK}
        try {
            expect(await dispatch(['__test-ext'])).toBe(EXIT.OK)
        } finally {
            delete cliRegistry['__test-ext']
        }
    })

    it('top-level resume --help returns OK and emits resume help', async () => {
        const chunks: string[] = []
        vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
            chunks.push(String(c))
            return true
        })
        const code = await dispatch(['resume', '--help'])
        expect(code).toBe(EXIT.OK)
        expect(chunks.join('')).toContain('re-check quota')
    })

    it("'run resume' is no longer an alias — usage error at dispatch", async () => {
        expect(await dispatch(['run', 'resume', '--help'])).toBe(EXIT.USAGE)
    })
})
