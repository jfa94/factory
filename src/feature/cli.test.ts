import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {featureCommand} from './cli.js'
import {FeatureStore} from './store.js'
import {specDir} from '../core/state/paths.js'
import {validateFeatureSpec} from './schema.js'

const fake = vi.hoisted(() => ({
    root: '',
    sha: 'a'.repeat(40),
    resolve: vi.fn(),
    prd: vi.fn(),
    snapshot: vi.fn(),
    preflight: vi.fn(),
    clean: vi.fn(),
    diff: vi.fn<() => string>(),
}))
vi.mock('../git/index.js', () => ({DefaultGitClient: vi.fn(), resolveRepo: () => Promise.resolve('owner/repo')}))
vi.mock('../spec/store.js', () => ({
    SpecStore: class {
        resolveByIssue = fake.resolve
    },
}))
vi.mock('../spec/gh.js', () => ({
    RealGhClient: class {
        fetchPrd = fake.prd
    },
}))
vi.mock('../spec/snapshot.js', () => ({repositorySnapshot: fake.snapshot}))
vi.mock('./preflight.js', () => ({assertFeatureEnvironment: fake.preflight}))
vi.mock('./runtime.js', () => ({
    LocalFeatureRuntime: class {
        now = () => '2026-09-07T00:00:00Z'
        checked = (_name: string, args: string[]) =>
            Promise.resolve(args.includes('--show-toplevel') ? fake.root : args[0] === 'diff' ? fake.diff() : fake.sha)
        head = () => Promise.resolve(fake.sha)
        clean = fake.clean
        ancestor = () => Promise.resolve(true)
        prepare = () => Promise.resolve(undefined)
        exempt = () => Promise.resolve(true)
        quota = () => Promise.resolve(undefined)
        checks = () => Promise.resolve({passed: true, observed: 1, details: [], assertionFailure: false})
        snapshot = () => Promise.resolve(join(fake.root, 'review'))
        databaseChanged = () => Promise.resolve(false)
    },
}))

let dir = '',
    dataDir = '',
    output = '',
    errors = ''
beforeEach(async () => {
    vi.clearAllMocks()
    dir = await mkdtemp(join(tmpdir(), 'feature-cli-'))
    dataDir = join(dir, 'data')
    fake.root = dir
    vi.stubEnv('CLAUDE_PLUGIN_DATA', dataDir)
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'owner-session')
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        output += String(chunk)
        return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        errors += String(chunk)
        return true
    })
    output = ''
    errors = ''
    fake.clean.mockResolvedValue(true)
    fake.diff.mockReturnValue('value.ts')
    fake.preflight.mockResolvedValue(undefined)
    const spec = validateFeatureSpec({
        version: 2,
        revision: 1,
        base_sha: fake.sha,
        contracts: {},
        prd: {issue_number: 1, title: 'Value', body: '- Return a value.', labels: [], body_truncated: false},
        spec_md: 'Return a value.',
        tasks: [
            {
                task_id: 'value',
                slice_id: 'slice',
                requirement_ids: ['R1'],
                title: 'Return value',
                description: 'Return the requested value.',
                files: ['value.ts'],
                acceptance_criteria: ['Return a value.'],
                tests_to_write: ['Assert the value.'],
                depends_on: [],
                risk_tier: 'low',
                risk_rationale: 'Local value',
            },
        ],
    })
    const path = specDir(join(dataDir, 'v2'), 'owner/repo', '1-value')
    await mkdir(path, {recursive: true})
    await writeFile(join(path, 'feature.json'), JSON.stringify(spec))
    fake.resolve.mockResolvedValue({spec_id: '1-value'})
    fake.prd.mockResolvedValue(spec.prd)
    fake.snapshot.mockResolvedValue({base_sha: fake.sha, contracts: {}})
})
afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await rm(dir, {recursive: true})
})
const call = (name: string, ...args: string[]) => featureCommand(name).run(args)

describe('v2 CLI contract', () => {
    it('creates a fresh run with persisted flags, lists it, dispatches, stops and recovers', async () => {
        expect(
            await call('run', 'create', '--issue', '1', '--run-id', 'run', '--no-ship', '--e2e', '--ignore-quota')
        ).toBe(0)
        expect(fake.preflight).toHaveBeenCalledOnce()
        const store = new FeatureStore(dataDir)
        expect(await store.read('run')).toMatchObject({
            ship_mode: 'no-ship',
            e2e: true,
            ignore_quota: true,
            owner_session: 'owner-session',
        })
        output = ''
        expect(await call('state', '--list')).toBe(0)
        expect(JSON.parse(output)).toMatchObject([{run_id: 'run'}])
        output = ''
        await call('next-action', '--run', 'run', '--driver', 'driver')
        const action = JSON.parse(output) as {attempt: {id: string; spec_digest: string}; staged: {implementer: string}}
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'implement'}})
        expect(action.staged.implementer).toBe(join(dataDir, 'staged-v2', 'run', action.attempt.id, 'implementer.json'))
        await writeFile(
            action.staged.implementer,
            JSON.stringify({
                attempt_id: action.attempt.id,
                spec_digest: action.attempt.spec_digest,
                head_sha: fake.sha,
                status: 'needs-context',
                message: 'Which value?',
            })
        )
        await call('next-action', '--run', 'run', '--driver', 'driver')
        await call('resume', '--run', 'run', '--answer', 'Use 5')
        await call('next-task', '--run', 'run', '--driver', 'next-driver')
        await call('run', 'stop', '--run', 'run')
        output = ''
        await call('state', '--run', 'run', '--ledger')
        expect(output).toContain('Use 5')
        expect(output).toContain(
            'In flight: implement [implementer] issued 2026-09-07T00:00:00Z (0m ago). Staged results: 0/1.'
        )
        expect(output).toContain('Next: factory resume --run run --recover')
        await call('resume', '--run', 'run', '--recover')
        output = ''
        await call('state', '--run', 'run', '--ledger')
        expect(output).toContain('Next: factory next-action --run run --driver <session>')
        await call('run', 'cancel', '--run', 'run')
        output = ''
        await call('state', '--run', 'run')
        expect(JSON.parse(output)).toMatchObject({status: 'cancelled'})
    })
    it('persists a local ship mode and rejects conflicting or malformed ship flags', async () => {
        expect(await call('run', 'create', '--issue', '1', '--run-id', 'both', '--no-ship', '--local')).toBe(2)
        expect(await call('run', 'create', '--issue', '1', '--run-id', 'local', '--local', '--ignore-quota')).toBe(0)
        expect(await new FeatureStore(dataDir).read('local')).toMatchObject({ship_mode: 'local'})
        expect(await call('resume', '--run', 'local', '--ship', 'merge')).toBe(2)
        expect(await call('resume', '--run', 'local', '--ship', 'live')).toBe(0)
        expect(await new FeatureStore(dataDir).read('local')).toMatchObject({ship_mode: 'live'})
    })
    it('creates a debug review from a committed diff without authorizing merge', async () => {
        expect(await call('debug', 'create', '--base', 'develop', '--run-id', 'debug', '--ignore-quota')).toBe(0)
        const run = await new FeatureStore(dataDir).read('debug')
        expect(run).toMatchObject({debug: true, ship_mode: 'no-ship', accepted_sha: fake.sha})
        expect(run.spec.tasks[0]?.files).toEqual(['value.ts'])
        expect(fake.preflight).not.toHaveBeenCalled()
        output = ''
        await call('next-action', '--run', 'debug', '--driver', 'driver')
        expect(JSON.parse(output)).toMatchObject({kind: 'execute', attempt: {stage: 'feature-review'}})
    })
    it.each(['dirty', 'empty'])('rejects a non-reviewable debug diff: %s', async (kind) => {
        if (kind === 'dirty') {
            fake.clean.mockResolvedValue(false)
        } else {
            fake.diff.mockReturnValue('')
        }
        await expect(call('debug', 'create', '--base', 'develop')).rejects.toThrow(
            kind === 'dirty' ? 'commit or stash' : 'nonempty'
        )
        expect(await new FeatureStore(dataDir).list()).toEqual([])
    })
    it.each(['missing', 'changed-prd', 'changed-base', 'protection'])(
        'refuses unusable reviewed inputs: %s',
        async (kind) => {
            if (kind === 'missing') {
                fake.resolve.mockResolvedValue(undefined)
            }
            if (kind === 'changed-prd') {
                fake.prd.mockResolvedValue({body: 'changed'})
            }
            if (kind === 'changed-base') {
                fake.snapshot.mockResolvedValue({base_sha: 'b'.repeat(40), contracts: {}})
            }
            if (kind === 'protection') {
                fake.preflight.mockRejectedValue(new Error('protection missing'))
            }
            await expect(call('run', 'create', '--issue', '1')).rejects.toThrow()
            expect(await new FeatureStore(dataDir).list()).toEqual([])
        }
    )
    it.each(['rescue', 'reconcile', 'score', 'miss'])('rejects retired commands: %s', async (name) => {
        expect(await call(name, '--help')).toBe(2)
        expect(errors).toContain('retired')
    })
    it('rejects malformed flags and unsupported operations while retaining help', async () => {
        expect(await call('run', '--help')).toBe(0)
        expect(output).toContain('Factory v2')
        expect(await call('run', 'reset')).toBe(2)
        expect(await call('run', 'create', '--issue', '0')).toBe(2)
        expect(await call('run', 'create', '--issue', '1', '--supersede')).toBe(2)
        expect(await call('next-action', '--run', 'run', '--driver', 'driver', '--results', 'x.json')).toBe(2)
        expect(await call('debug', 'unsupported', '--run-id', 'run')).toBe(2)
    })
})
