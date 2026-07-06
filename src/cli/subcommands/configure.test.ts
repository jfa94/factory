/**
 * Unit tests for `factory configure`. Each test gets an isolated temp data dir via
 * $CLAUDE_PLUGIN_DATA so the config writer/reader round-trips on real disk without
 * touching the host's config.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import {mkdtemp, rm, readFile, mkdir, writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {configureCommand} from './configure.js'
import {EXIT} from '../../shared/exit-codes.js'
import type {Config} from '../../config/index.js'
import type {DetectReport} from '../../ci/index.js'

let dataDir: string
let prevEnv: string | undefined
let stdout: string[]
let stderr: string[]

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'factory-configure-'))
    prevEnv = process.env.CLAUDE_PLUGIN_DATA
    process.env.CLAUDE_PLUGIN_DATA = dataDir
    stdout = []
    stderr = []
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
        stdout.push(String(c))
        return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
        stderr.push(String(c))
        return true
    })
})

afterEach(async () => {
    vi.restoreAllMocks()
    if (prevEnv === undefined) {
        delete process.env.CLAUDE_PLUGIN_DATA
    } else {
        process.env.CLAUDE_PLUGIN_DATA = prevEnv
    }
    await rm(dataDir, {recursive: true, force: true})
})

const out = (): Config => JSON.parse(stdout.join('')) as Config
const outReport = (): DetectReport => JSON.parse(stdout.join('')) as DetectReport

describe('factory configure', () => {
    it('prints the resolved config (all defaults) when no overlay exists', async () => {
        const code = await configureCommand.run([])
        expect(code).toBe(EXIT.OK)
        const cfg = out()
        expect(cfg).toHaveProperty('quality.holdoutPercent')
        expect(cfg).toHaveProperty('quota.hourlyThresholds')
        expect(existsSync(join(dataDir, 'config.json'))).toBe(false) // read-only path wrote nothing
    })

    it('--set persists a SPARSE overlay (only the edited key) and echoes the resolved config', async () => {
        const code = await configureCommand.run(['--set', 'quality.holdoutPercent=25'])
        expect(code).toBe(EXIT.OK)
        expect(out().quality.holdoutPercent).toBe(25)

        // On-disk overlay is sparse: it contains ONLY the edited path, not all defaults.
        const overlay = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>
        expect(overlay).toEqual({quality: {holdoutPercent: 25}})
    })

    it('coerces JSON scalar types (number/boolean) and falls back to string', async () => {
        await configureCommand.run(['--set', 'git.stagingBranch=staging'])
        const overlay = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as {
            git: {stagingBranch: unknown}
        }
        expect(overlay.git.stagingBranch).toBe('staging') // bare string
    })

    it('--set creates a nested gateEnv record leaf and round-trips it', async () => {
        const code = await configureCommand.run([
            '--set',
            'quality.gateEnv.NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321',
            '--set',
            'quality.gateEnv.NEXT_PUBLIC_SUPABASE_KEY=ci-placeholder',
        ])
        expect(code).toBe(EXIT.OK)
        expect(out().quality.gateEnv).toEqual({
            NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
            NEXT_PUBLIC_SUPABASE_KEY: 'ci-placeholder',
        })
        // Sparse overlay holds only the nested leaves.
        const overlay = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>
        expect(overlay).toEqual({
            quality: {
                gateEnv: {
                    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
                    NEXT_PUBLIC_SUPABASE_KEY: 'ci-placeholder',
                },
            },
        })
    })

    it('--get prints a single resolved value', async () => {
        await configureCommand.run(['--set', 'maxConsecutiveFailures=7'])
        stdout.length = 0
        const code = await configureCommand.run(['--get', 'maxConsecutiveFailures'])
        expect(code).toBe(EXIT.OK)
        expect(JSON.parse(stdout.join(''))).toBe(7)
    })

    it('--unset reverts a key to its default and prunes the empty parent', async () => {
        await configureCommand.run(['--set', 'quality.holdoutPercent=25'])
        const defaultPct = (await import('../../config/index.js')).defaultConfig().quality.holdoutPercent

        stdout.length = 0
        const code = await configureCommand.run(['--unset', 'quality.holdoutPercent'])
        expect(code).toBe(EXIT.OK)
        expect(out().quality.holdoutPercent).toBe(defaultPct)
        // The now-empty `quality` overlay object is pruned.
        const overlay = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>
        expect(overlay).toEqual({})
    })

    it('rejects an out-of-schema value LOUDLY without persisting it', async () => {
        // holdoutPercent must be 0..100; 999 is a schema violation → throw (not USAGE).
        await expect(configureCommand.run(['--set', 'quality.holdoutPercent=999'])).rejects.toThrow()
        // Nothing persisted.
        expect(existsSync(join(dataDir, 'config.json'))).toBe(false)
    })

    it('multiple --set tokens apply in one atomic write', async () => {
        const code = await configureCommand.run([
            '--set',
            'quality.holdoutPercent=30',
            '--set',
            'maxConsecutiveFailures=5',
        ])
        expect(code).toBe(EXIT.OK)
        const overlay = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>
        expect(overlay).toEqual({quality: {holdoutPercent: 30}, maxConsecutiveFailures: 5})
    })

    it('--get combined with --set is a USAGE error', async () => {
        const code = await configureCommand.run(['--get', 'quality', '--set', 'x=1'])
        expect(code).toBe(EXIT.USAGE)
        expect(stderr.join('')).toMatch(/cannot be combined/)
    })

    it('--get rejects an unknown config key', async () => {
        await expect(configureCommand.run(['--get', 'bogus.key'])).rejects.toThrow(/unknown config key/)
    })

    it('--get rejects traversing into a non-object leaf', async () => {
        await expect(configureCommand.run(['--get', 'quality.holdoutPercent.foo'])).rejects.toThrow(/not an object/)
    })

    it("--set rejects a malformed token with no '='", async () => {
        await expect(configureCommand.run(['--set', 'keyWithoutEquals'])).rejects.toThrow(/expects 'key.path=value'/)
        expect(existsSync(join(dataDir, 'config.json'))).toBe(false)
    })

    it('--set rejects an invalid key path (empty segment)', async () => {
        await expect(configureCommand.run(['--set', 'a..b=1'])).rejects.toThrow(/invalid key path/)
        expect(existsSync(join(dataDir, 'config.json'))).toBe(false)
    })

    it('--help returns OK', async () => {
        expect(await configureCommand.run(['--help'])).toBe(EXIT.OK)
        expect(stdout.join('')).toMatch(/factory configure/)
    })

    describe('--detect-gate-env', () => {
        const WORKFLOW = `jobs:
  quality:
    steps:
      - run: pnpm build
        env:
          NEXT_PUBLIC_SUPABASE_URL: http://localhost:54321
          API_TOKEN: \${{ secrets.API_TOKEN }}
`
        let repoRoot: string
        let prevCwd: string

        const enterRepo = async (withWorkflow: boolean) => {
            repoRoot = await mkdtemp(join(tmpdir(), 'factory-configure-repo-'))
            if (withWorkflow) {
                const dir = join(repoRoot, '.github', 'workflows')
                await mkdir(dir, {recursive: true})
                await writeFile(join(dir, 'quality-gate.yml'), WORKFLOW, 'utf8')
            }
            prevCwd = process.cwd()
            process.chdir(repoRoot)
        }

        afterEach(async () => {
            if (prevCwd) {
                process.chdir(prevCwd)
            }
            if (repoRoot) {
                await rm(repoRoot, {recursive: true, force: true})
            }
        })

        it('detects into an empty config, writing the literal var and dropping the secret ref', async () => {
            await enterRepo(true)
            const code = await configureCommand.run(['--detect-gate-env'])
            expect(code).toBe(EXIT.OK)
            const report = outReport()
            expect(report.written).toEqual(['NEXT_PUBLIC_SUPABASE_URL'])
            expect(report.skippedExpressionRefs.map((r) => r.key)).toEqual(['API_TOKEN'])
            // Sparse overlay holds only the detected literal.
            const overlay = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>
            expect(overlay).toEqual({
                quality: {gateEnv: {NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321'}},
            })
        })

        it('re-running is idempotent (written empty, overlay unchanged)', async () => {
            await enterRepo(true)
            await configureCommand.run(['--detect-gate-env'])
            const overlay = await readFile(join(dataDir, 'config.json'), 'utf8')
            stdout.length = 0
            await configureCommand.run(['--detect-gate-env'])
            expect(outReport().written).toEqual([])
            expect(await readFile(join(dataDir, 'config.json'), 'utf8')).toBe(overlay)
        })

        it('writes nothing when there is no workflow dir', async () => {
            await enterRepo(false)
            const code = await configureCommand.run(['--detect-gate-env'])
            expect(code).toBe(EXIT.OK)
            expect(outReport().written).toEqual([])
            expect(existsSync(join(dataDir, 'config.json'))).toBe(false)
        })

        it('--detect-gate-env combined with --set is a USAGE error', async () => {
            await enterRepo(true)
            const code = await configureCommand.run(['--detect-gate-env', '--set', 'x=1'])
            expect(code).toBe(EXIT.USAGE)
            expect(stderr.join('')).toMatch(/cannot be combined/)
        })
    })
})
