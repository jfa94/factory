import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {FeatureStore} from './store.js'
import {featureRunFixture} from './test-fixtures.js'

let dataDir: string
beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'feature-store-'))
})
afterEach(async () => {
    await rm(dataDir, {recursive: true, force: true})
})

describe('FeatureStore integrity checks', () => {
    it('lists nothing before any run exists and names a missing run', async () => {
        const store = new FeatureStore(dataDir)
        await expect(store.list()).resolves.toEqual([])
        await expect(store.read('run')).rejects.toThrow(/run run is missing or uses an unsupported version/)
    })

    it('reports whether a run directory exists and surfaces unreadable data directories', async () => {
        const store = new FeatureStore(dataDir)
        expect(await store.exists('run')).toBe(false)
        await store.write(featureRunFixture())
        expect(await store.exists('run')).toBe(true)
        const file = join(dataDir, 'not-a-dir')
        await writeFile(file, '')
        const broken = new FeatureStore(file)
        await expect(broken.exists('run')).rejects.toThrow(/ENOTDIR/)
        await expect(broken.skipped()).rejects.toThrow(/ENOTDIR/)
    })

    it('refuses to write a run whose spec digest does not match its snapshot', async () => {
        const run = featureRunFixture({spec_digest: 'f'.repeat(64)})
        await expect(new FeatureStore(dataDir).write(run)).rejects.toThrow(/spec snapshot digest mismatch/)
    })

    it('refuses to read a run whose state names another run id', async () => {
        const store = new FeatureStore(dataDir)
        await store.write(featureRunFixture())
        const path = join(store.dir('run'), 'state.json')
        const state = JSON.parse(await readFile(path, 'utf8')) as {run_id: string}
        await writeFile(path, JSON.stringify({...state, run_id: 'other'}))
        await expect(store.read('run')).rejects.toThrow(/corrupt identity or spec snapshot/)
    })

    it('surfaces malformed state JSON instead of treating it as missing', async () => {
        const store = new FeatureStore(dataDir)
        await store.write(featureRunFixture())
        await writeFile(join(store.dir('run'), 'state.json'), '{')
        await expect(store.read('run')).rejects.toThrow(SyntaxError)
    })
})

describe('FeatureStore staged results', () => {
    const sha = 'a'.repeat(40)
    const attempt = {
        id: 'attempt',
        driver: 'driver',
        stage: 'slice-review' as const,
        base_sha: sha,
        head_sha: sha,
        spec_digest: 'digest',
        worktree: '/snapshot',
        roles: ['quality-reviewer', 'silent-failure-hunter'],
        issued_at: '2026-10-05T00:00:00Z',
    }
    const claim = {severity: 'important', file: 'value.ts', line: 3, quote: 'return wrongValue', claim: 'Wrong value'}

    it('binds reviewer identity and claim ids from the staged path', async () => {
        const store = new FeatureStore(dataDir)
        const paths = await store.stage('run', attempt)
        await writeFile(paths['quality-reviewer'] ?? '', JSON.stringify({status: 'done', claims: [claim, claim]}))
        await writeFile(paths['silent-failure-hunter'] ?? '', JSON.stringify({status: 'done', claims: []}))
        expect(await store.staged('run', attempt)).toEqual({
            result: {
                status: 'done',
                reviews: [
                    {
                        reviewer: 'quality-reviewer',
                        claims: [
                            {id: 'quality-reviewer.1', reviewer: 'quality-reviewer', ...claim},
                            {id: 'quality-reviewer.2', reviewer: 'quality-reviewer', ...claim},
                        ],
                    },
                    {reviewer: 'silent-failure-hunter', claims: []},
                ],
            },
        })
    })

    it('strips legacy identity fields and lets a halted status win', async () => {
        const store = new FeatureStore(dataDir)
        const paths = await store.stage('run', attempt)
        const legacy = {attempt_id: 'other', spec_digest: 'x', head_sha: 'b'.repeat(40), reviewer: 'spoofed'}
        await writeFile(paths['quality-reviewer'] ?? '', JSON.stringify({...legacy, status: 'done', claims: []}))
        await writeFile(
            paths['silent-failure-hunter'] ?? '',
            JSON.stringify({...legacy, status: 'needs-context', message: 'Which reading?'})
        )
        expect(await store.staged('run', attempt)).toEqual({
            result: {
                status: 'needs-context',
                message: 'Which reading?',
                reviews: [{reviewer: 'quality-reviewer', claims: []}],
            },
        })
    })

    it('writes briefs beside results without counting them as submissions', async () => {
        const store = new FeatureStore(dataDir)
        const path = await store.writeBrief('run', attempt, 'quality-reviewer', '# brief')
        expect(path).toBe(join(dataDir, 'staged-v2', 'run', 'attempt', 'quality-reviewer.brief.md'))
        expect(await store.stagedPresent('run', attempt)).toEqual([])
        expect(await store.staged('run', attempt)).toEqual({missing: attempt.roles, invalid: {}})
    })
})
