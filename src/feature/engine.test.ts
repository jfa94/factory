import {mkdtemp, mkdir, writeFile, readFile, rm, symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach, describe, expect, it} from 'vitest'
import {exec, execOrThrow, type ExecResult} from '../shared/exec.js'
import {at} from '../shared/assert.js'
import {decideFeatureGuard} from '../hooks/feature-guards.js'
import {decideWriteProtection} from '../hooks/write-protection.js'
import {fileURLToPath} from 'node:url'
import {defaultConfig} from '../config/schema.js'
import {FeatureStore} from './store.js'
import {FeatureEngine} from './engine.js'
import {LocalFeatureRuntime} from './runtime.js'
import {validateFeatureSpec, type FeatureAction, type FeatureResult} from './schema.js'

const dirs: string[] = []
afterEach(async () => {
    for (const path of dirs.splice(0)) {
        await rm(path, {recursive: true})
    }
})
const git = async (cwd: string, ...args: string[]) => (await execOrThrow('git', args, {cwd})).stdout.trim()

async function fixture(mode: 'live' | 'no-ship' = 'no-ship', exempt = true) {
    const dir = await mkdtemp(join(tmpdir(), 'feature-v2-'))
    dirs.push(dir)
    const root = join(dir, 'repo'),
        remote = join(dir, 'remote.git')
    await mkdir(root)
    await git(root, 'init', '-b', 'develop')
    await git(root, 'config', 'user.name', 'Fixture')
    await git(root, 'config', 'user.email', 'fixture@example.invalid')
    await git(root, 'config', 'commit.gpgsign', 'false')
    await git(root, 'init', '--bare', remote)
    await git(root, 'remote', 'add', 'origin', remote)
    await mkdir(join(root, '.factory'))
    const gates = Object.fromEntries(
        ['test', 'tdd', 'type', 'lint', 'build', 'coverage', 'mutation', 'sast'].map((id) => [
            id,
            id === 'test'
                ? {contracted: true, command: 'npm run test'}
                : {contracted: false, reason: 'plain JavaScript fixture'},
        ])
    )
    await writeFile(join(root, '.factory/gates.json'), JSON.stringify({version: 1, stack: 'npm', gates}))
    await writeFile(join(root, '.gitignore'), '.claude/\nnode_modules/\n')
    await writeFile(
        join(root, 'package.json'),
        JSON.stringify({type: 'module', scripts: {test: 'node --test'}, factory: {tddExempt: exempt}})
    )
    await writeFile(join(root, 'value.js'), 'export const value = 0\n')
    await writeFile(
        join(root, 'value.test.js'),
        "import {test} from 'node:test'\nimport {ok} from 'node:assert/strict'\nimport {value} from './value.js'\ntest('value is nonnegative', () => ok(value >= 0))\n"
    )
    await git(root, 'add', '.')
    await git(root, 'commit', '-m', 'fixture baseline')
    await git(root, 'push', '-u', 'origin', 'develop')
    const sha = await git(root, 'rev-parse', 'HEAD')
    const task = (id: string, depends_on: string[]) => ({
        task_id: id,
        slice_id: id,
        requirement_ids: ['R1'],
        title: `Deliver value ${id}`,
        description: 'Update the value with an independently tested checkpoint.',
        files: ['value.js', 'value.test.js', 'README.md', 'notes.md'],
        acceptance_criteria: ['Value is available and tests pass.'],
        tests_to_write: ['Test the updated value.'],
        depends_on,
        risk_tier: 'low',
        risk_rationale: 'Local example',
    })
    const spec = validateFeatureSpec({
        version: 2,
        revision: 1,
        base_sha: sha,
        contracts: {},
        prd: {
            issue_number: 17,
            title: 'Deliver values',
            body: '- Value is available and tests pass.',
            labels: [],
            body_truncated: false,
        },
        spec_md: 'Two ordered slices share the value interface.',
        tasks: [task('first', []), task('second', ['first'])],
    })
    const store = new FeatureStore(join(dir, 'data'))
    const runtime = new LocalFeatureRuntime(defaultConfig(), {
        read: () => Promise.reject(new Error('quota disabled')),
    })
    const deliveries: string[] = []
    runtime.mergedDelivery = () => Promise.resolve(undefined)
    runtime.deliver = async (run) => {
        const head = await runtime.head(run.worktree)
        await git(run.worktree, 'push', '-u', 'origin', `HEAD:refs/heads/${run.branch}`)
        deliveries.push(head)
        return {kind: mode === 'no-ship' ? 'review' : 'pending', number: 1, url: 'https://example.invalid/pr/1', head}
    }
    const engine = new FeatureEngine(store, runtime)
    const run = await engine.create({
        runId: 'run',
        repo: 'example/app',
        root,
        spec,
        baseBranch: 'develop',
        remote: 'origin',
        ignoreQuota: true,
        shipMode: mode,
    })
    return {dir, root, store, runtime, engine, run, deliveries}
}

function result(action: FeatureAction, extra: Partial<FeatureResult> = {}): FeatureResult {
    if (action.kind !== 'execute') {
        throw new Error(`expected execute, got ${JSON.stringify(action)}`)
    }
    return {
        attempt_id: action.attempt.id,
        spec_digest: action.attempt.spec_digest,
        head_sha: action.attempt.head_sha,
        status: 'done',
        ...extra,
    }
}

async function respond(
    f: Awaited<ReturnType<typeof fixture>>,
    action: FeatureAction,
    noChange = false
): Promise<FeatureAction> {
    if (action.kind !== 'execute') {
        return action
    }
    const {attempt} = action
    const response = result(action)
    if (attempt.stage === 'implement') {
        if (noChange) {
            response.status = 'already-satisfied'
        } else {
            const run = await f.store.read('run')
            const value = run.task_index + 1
            await writeFile(join(attempt.worktree, 'value.js'), `export const value = ${value}\n`)
            await git(attempt.worktree, 'add', 'value.js')
            await git(
                attempt.worktree,
                'commit',
                '-m',
                `[${at(run.spec.tasks, run.task_index).task_id}] value ${value}`
            )
            response.head_sha = await f.runtime.head(attempt.worktree)
        }
    } else if (attempt.stage.endsWith('review')) {
        response.reviews = attempt.roles.map((reviewer) => ({reviewer, claims: []}))
    } else if (attempt.stage === 'acceptance') {
        const run = await f.store.read('run')
        const ids = run.candidate_satisfied
            ? [`${at(run.spec.tasks, run.task_index).task_id}:AC1`]
            : ['R1', 'first:AC1', 'second:AC1']
        response.acceptance = ids.map((id) => ({
            id,
            met: true,
            evidence: 'value.test.js executes the current value behavior successfully',
        }))
    }
    return new FeatureEngine(f.store, f.runtime).advance('run', 'driver', response)
}

describe('sequential feature execution with real Git', {timeout: 30_000}, () => {
    it('parks after exactly three repair passes and preserves all committed work', async () => {
        const f = await fixture()
        f.runtime.checks = () =>
            Promise.resolve({passed: false, observed: 1, details: ['type error'], assertionFailure: false})
        let action = await f.engine.advance('run', 'driver')
        for (let pass = 0; pass < 4; pass++) {
            if (action.kind !== 'execute') {
                throw new Error('repair ended too early')
            }
            await writeFile(join(action.attempt.worktree, 'value.js'), `export const value = ${pass + 1}\n`)
            await git(action.attempt.worktree, 'add', 'value.js')
            await git(action.attempt.worktree, 'commit', '-m', `[first] repair attempt ${pass}`)
            action = await f.engine.advance(
                'run',
                'driver',
                result(action, {head_sha: await f.runtime.head(action.attempt.worktree)})
            )
        }
        expect(action).toMatchObject({kind: 'park'})
        const run = await f.store.read('run')
        expect(run.attempts['task:first']).toBe(3)
        expect(run.stop_reason?.message).toContain('3 repair passes exhausted')
        expect(await git(run.worktree, 'rev-list', '--count', `${run.spec.base_sha}..HEAD`)).toBe('4')
    })

    it('parks at the CI deadline and gives explicit resume a fresh wait window', async () => {
        const f = await fixture('live')
        await f.engine.advance('run', 'driver')
        const run = await f.store.read('run')
        delete run.in_flight
        run.stage = 'deliver'
        await writeFile(join(run.worktree, 'value.js'), 'export const value = 1\n')
        await git(run.worktree, 'add', 'value.js')
        await git(run.worktree, 'commit', '-m', '[first] CI fixture')
        run.verified_feature = {head_sha: await f.runtime.head(run.worktree), spec_digest: run.spec_digest}
        await f.store.write(run)
        let clock = Date.parse('2026-09-05T00:00:00Z')
        f.runtime.now = () => new Date(clock).toISOString()
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'wait'})
        clock += (f.runtime.ciWaitMinutes + 1) * 60_000
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'park'})
        expect((await f.store.read('run')).attempts).toEqual({})
        await f.engine.resume('run')
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'wait'})
    })

    it('recovers a lost PR-create response without creating another PR or changing protection', async () => {
        const f = await fixture('live')
        await f.engine.advance('run', 'driver')
        const run = await f.store.read('run')
        const head = await f.runtime.head(run.worktree)
        let created = false
        let merged = false
        const calls: string[][] = []
        const reply = (value: unknown, code = 0): ExecResult => ({
            stdout: JSON.stringify(value),
            stderr: '',
            code,
            signal: null,
            truncated: false,
        })
        const runtime = new LocalFeatureRuntime(
            defaultConfig(),
            {read: () => Promise.reject(new Error('quota unused'))},
            async (name, args, cwd) => {
                if (name !== 'gh') {
                    return exec(name, args, {cwd})
                }
                calls.push([...args])
                if (args[0] !== 'pr') {
                    throw new Error('unexpected protection/API mutation')
                }
                if (args[1] === 'list') {
                    return reply(
                        created && (!args.includes('merged') || merged)
                            ? [
                                  {
                                      number: 12,
                                      url: 'https://example.invalid/pr/12',
                                      state: merged ? 'MERGED' : 'OPEN',
                                      headRefOid: head,
                                      baseRefName: 'develop',
                                  },
                              ]
                            : []
                    )
                }
                if (args[1] === 'create') {
                    created = true
                    return reply('lost response after server accepted create', 1)
                }
                if (args[1] === 'checks') {
                    return reply([{bucket: 'pass', name: 'Quality'}])
                }
                if (args[1] === 'merge') {
                    return reply({})
                }
                throw new Error(`unexpected gh command ${args.join(' ')}`)
            }
        )
        await expect(runtime.deliver(run)).rejects.toThrow('lost response')
        expect(await runtime.deliver(run)).toMatchObject({kind: 'pending', number: 12})
        expect(calls.filter((args) => args[1] === 'create')).toHaveLength(1)
        merged = true
        expect(await runtime.mergedDelivery(run)).toMatchObject({kind: 'merged', number: 12, head})
        expect(await git(run.worktree, 'rev-parse', `origin/${run.branch}`)).toBe(head)
    })

    it('refreshes an existing PR after a repair push and waits for delayed HEAD propagation', async () => {
        const f = await fixture()
        await f.engine.advance('run', 'driver')
        const run = await f.store.read('run')
        let observed = await f.runtime.head(run.worktree)
        await git(run.worktree, 'push', '-u', 'origin', `HEAD:refs/heads/${run.branch}`)
        await writeFile(join(run.worktree, 'value.js'), 'export const value = 4\n')
        await git(run.worktree, 'add', 'value.js')
        await git(run.worktree, 'commit', '-m', '[first] repair existing PR')
        const repaired = await f.runtime.head(run.worktree)
        let propagate = false
        let lists = 0
        const runtime = new LocalFeatureRuntime(
            defaultConfig(),
            {
                read: () => Promise.reject(new Error('quota unused')),
            },
            async (name, args, cwd) => {
                if (name !== 'gh') {
                    const response = await exec(name, args, {cwd})
                    if (args[0] === 'push' && propagate) {
                        observed = repaired
                    }
                    return response
                }
                if (args[0] !== 'pr' || args[1] !== 'list') {
                    throw new Error('must reuse the existing PR')
                }
                lists++
                return {
                    stdout: JSON.stringify([
                        {
                            number: 12,
                            url: 'https://example.invalid/pr/12',
                            state: 'OPEN',
                            headRefOid: observed,
                            baseRefName: 'develop',
                        },
                    ]),
                    stderr: '',
                    code: 0,
                    signal: null,
                    truncated: false,
                }
            }
        )
        expect(await runtime.deliver(run)).toMatchObject({kind: 'pending', number: 12, head: repaired})
        expect(lists).toBe(2)
        propagate = true
        expect(await runtime.deliver(run)).toMatchObject({kind: 'review', number: 12, head: repaired})
        expect(lists).toBe(4)
    })

    it('executes the native Vitest gate and counts its real test evidence', async () => {
        const f = await fixture()
        await symlink(
            fileURLToPath(new URL('../../node_modules', import.meta.url)),
            join(f.root, 'node_modules'),
            'dir'
        )
        const contract = JSON.parse(await readFile(join(f.root, '.factory/gates.json'), 'utf8')) as {
            gates: Record<string, unknown>
        }
        contract.gates.test = {contracted: true}
        await writeFile(join(f.root, '.factory/gates.json'), JSON.stringify(contract))
        await writeFile(
            join(f.root, 'value.test.js'),
            "import {test, expect} from 'vitest'\nimport {value} from './value.js'\ntest('value is nonnegative', () => expect(value).toBeGreaterThanOrEqual(0))\n"
        )
        await git(f.root, 'add', '.factory/gates.json', 'value.test.js')
        await git(f.root, 'commit', '-m', 'configure native test runner')
        const run = await f.store.read('run')
        run.accepted_sha = await git(f.root, 'rev-parse', 'HEAD')
        await f.store.write(run)
        await f.engine.advance('run', 'driver')
        const checks = await f.runtime.checks(await f.store.read('run'), 'task-check')
        expect(checks.passed).toBe(true)
        expect(checks.details.join('\n')).toContain('"executed_tests":1')
    })

    it('requires executed, unskipped e2e evidence at the feature boundary', async () => {
        const f = await fixture()
        await f.engine.advance('run', 'driver')
        const run = await f.store.read('run')
        run.e2e = true
        let stats = {expected: 2, unexpected: 0, skipped: 0, flaky: 0}
        let truncated = false
        const runtime = new LocalFeatureRuntime(
            defaultConfig(),
            {
                read: () => Promise.reject(new Error('quota unused')),
            },
            async (name, args, cwd) =>
                name === 'pnpm'
                    ? {
                          stdout: JSON.stringify({stats}),
                          stderr: '',
                          code: 0,
                          signal: null,
                          truncated,
                      }
                    : exec(name, args, {cwd})
        )
        expect((await runtime.checks(run, 'feature-check')).passed).toBe(true)
        stats = {...stats, skipped: 1}
        expect((await runtime.checks(run, 'feature-check')).passed).toBe(false)
        stats = {...stats, skipped: 0, expected: 0}
        expect((await runtime.checks(run, 'feature-check')).passed).toBe(false)
        truncated = true
        await expect(runtime.checks(run, 'feature-check')).rejects.toThrow('E2E evidence was truncated')
    })

    it('requires an actual failing test commit before a nonexempt implementation', async () => {
        const f = await fixture('no-ship', false)
        let action = await f.engine.advance('run', 'driver')
        if (action.kind !== 'execute' || action.attempt.stage !== 'tests') {
            throw new Error('missing test phase')
        }
        const worktree = action.attempt.worktree
        await writeFile(
            join(worktree, 'value.test.js'),
            "import {test} from 'node:test'\nimport {equal} from 'node:assert/strict'\nimport {value} from './value.js'\ntest('value is one', () => equal(value, 1))\n"
        )
        await git(worktree, 'add', 'value.test.js')
        await git(worktree, 'commit', '-m', '[first] failing value assertion')
        action = await f.engine.advance('run', 'driver', result(action, {head_sha: await f.runtime.head(worktree)}))
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'implement'}})
        action = await respond(f, action)
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'task-review'}})
    }, 30_000)

    it('consumes a durable result after a crash without repeating the producer', async () => {
        const f = await fixture()
        const action = await f.engine.advance('run', 'driver')
        if (action.kind !== 'execute') {
            throw new Error('missing attempt')
        }
        await writeFile(join(action.attempt.worktree, 'value.js'), 'export const value = 3\n')
        await git(action.attempt.worktree, 'add', 'value.js')
        await git(action.attempt.worktree, 'commit', '-m', '[first] durable producer result')
        await f.store.recordResult('run', result(action, {head_sha: await f.runtime.head(action.attempt.worktree)}))
        await f.engine.stop('run')
        const recovered = await new FeatureEngine(f.store, f.runtime).resume('run', {recover: true})
        expect(recovered.status).toBe('running')
        expect(recovered.stage).toBe('task-check')
        expect(recovered.in_flight).toBeUndefined()
        expect(recovered.audit.some((row) => row.event === 'durable result recovered')).toBe(true)
        expect(await f.engine.advance('run', 'new-driver')).toMatchObject({
            kind: 'execute',
            attempt: {stage: 'task-review'},
        })
    })

    it('rejects invalid review evidence and explicitly recovers without losing its journal or work', async () => {
        const f = await fixture()
        let action = await f.engine.advance('run', 'driver')
        action = await respond(f, action)
        if (action.kind !== 'execute' || action.attempt.stage !== 'task-review') {
            throw new Error('missing review')
        }
        await f.store.recordResult('run', result(action, {reviews: []}))
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'park'})
        expect((await f.store.read('run')).in_flight?.id).toBe(action.attempt.id)
        const head = await f.runtime.head(action.attempt.worktree)
        const recovered = await f.engine.resume('run', {recover: true})
        expect(recovered.in_flight).toBeUndefined()
        expect(recovered.status).toBe('running')
        expect(recovered.stage).toBe('task-review')
        expect(recovered.audit.at(-2)?.event).toBe('invalid durable result retired; evidence and work retained')
        expect(await f.store.result('run', action.attempt.id)).toMatchObject({reviews: []})
        expect(await f.runtime.head(action.attempt.worktree)).toBe(head)
        const next = await f.engine.advance('run', 'new-driver')
        expect(next).toMatchObject({kind: 'execute', attempt: {stage: 'task-review'}})
        if (next.kind !== 'execute') {
            throw new Error('missing recovered review')
        }
        expect(next.attempt.id).not.toBe(action.attempt.id)
    })

    it('recovers through fresh built CLI processes without discarding committed work', async () => {
        const f = await fixture()
        const binary = fileURLToPath(new URL('../../dist/factory.js', import.meta.url))
        const call = async (...args: string[]): Promise<unknown> =>
            JSON.parse(
                (
                    await execOrThrow(process.execPath, [binary, ...args], {
                        cwd: f.root,
                        env: {CLAUDE_PLUGIN_DATA: f.store.dataDir},
                    })
                ).stdout
            ) as unknown
        expect(await call('next-action', '--run', 'run', '--driver', 'old')).toMatchObject({kind: 'execute'})
        const run = await f.store.read('run')
        await writeFile(join(run.worktree, 'value.js'), 'export const value = 9\n')
        await git(run.worktree, 'add', 'value.js')
        await git(run.worktree, 'commit', '-m', '[first] interrupted producer checkpoint')
        const head = await git(run.worktree, 'rev-parse', 'HEAD')
        expect(await call('next-action', '--run', 'run', '--driver', 'new')).toMatchObject({kind: 'wait'})
        await call('run', 'stop', '--run', 'run')
        expect(await call('next-action', '--run', 'run', '--driver', 'new')).toMatchObject({kind: 'park'})
        await call('resume', '--run', 'run', '--recover')
        expect(await call('next-action', '--run', 'run', '--driver', 'new')).toMatchObject({
            kind: 'execute',
            attempt: {head_sha: head, driver: 'new'},
        })
        expect(await git(run.worktree, 'rev-parse', 'HEAD')).toBe(head)
    })

    it('guards owned feature paths while allowing an unrelated session', async () => {
        const f = await fixture()
        await f.engine.advance('run', 'driver')
        const run = await f.store.read('run')
        const attempt = run.in_flight
        if (!attempt) {
            throw new Error('missing fixture attempt')
        }
        attempt.stage = 'tests'
        const edit = (file_path: string) => ({tool_name: 'Edit', cwd: run.worktree, tool_input: {file_path}})
        expect(decideFeatureGuard(edit('value.js'), [run]).action).toBe('deny')
        expect(decideFeatureGuard(edit('value.test.js'), [run]).action).toBe('allow')
        expect(
            decideFeatureGuard({tool_name: 'Bash', cwd: run.worktree, tool_input: {command: 'git push origin HEAD'}}, [
                run,
            ]).action
        ).toBe('deny')
        expect(
            decideFeatureGuard({tool_name: 'Edit', cwd: '/unrelated', tool_input: {file_path: 'value.js'}}, [run])
                .action
        ).toBe('allow')
        attempt.stage = 'task-review'
        expect(decideFeatureGuard(edit('value.test.js'), [run]).action).toBe('deny')
    })

    it('protects v2 engine stores for owned workers across all write tools', async () => {
        const f = await fixture()
        await f.engine.advance('run', 'driver')
        const run = await f.store.read('run')
        const paths = [
            'runs-v2/run/state.json',
            'runs-v2/run/results/attempt.json',
            'v2/specs/repo/17/feature.json',
            'locks-v2/repo',
        ]
        for (const path of paths) {
            const file_path = join(f.store.dataDir, path)
            const inputs = [
                {tool_name: 'Edit', tool_input: {file_path}},
                {tool_name: 'Write', tool_input: {file_path}},
                {tool_name: 'MultiEdit', tool_input: {edits: [{file_path}]}},
                {tool_name: 'Bash', tool_input: {command: `printf x > ${file_path}`}},
            ]
            for (const input of inputs) {
                const owned = {...input, cwd: run.worktree}
                expect(decideFeatureGuard(owned, [run], f.store.dataDir).action).toBe('deny')
                expect(
                    decideWriteProtection(owned, {cwd: run.worktree, autonomousMode: true, dataDir: f.store.dataDir})
                        .action
                ).toBe('deny')
            }
        }
    })

    it('does not let producer edits change the baseline TDD exemption', async () => {
        const f = await fixture()
        await f.engine.advance('run', 'driver')
        const run = await f.store.read('run')
        await writeFile(join(run.worktree, 'package.json'), JSON.stringify({factory: {tddExempt: false}}))
        expect(await f.runtime.exempt(run)).toBe(true)
    })

    it('rechecks a clean base integration without spending a producer repair pass', async () => {
        const f = await fixture()
        await f.engine.advance('run', 'driver')
        const run = await f.store.read('run')
        delete run.in_flight
        run.stage = 'deliver'
        await f.store.write(run)
        f.runtime.reconcileBase = () => Promise.resolve('merged')
        const action = await f.engine.advance('run', 'driver')
        expect(action.kind === 'execute' && action.attempt.stage).toBe('feature-review')
        expect((await f.store.read('run')).attempts).toEqual({})
    })

    it('reverifies a base merge completed before the delivery checkpoint was persisted', async () => {
        const f = await fixture()
        await f.engine.advance('run', 'driver')
        const run = await f.store.read('run')
        delete run.in_flight
        run.stage = 'deliver'
        run.verified_feature = {head_sha: await f.runtime.head(run.worktree), spec_digest: run.spec_digest}
        await f.store.write(run)
        await writeFile(join(f.root, 'base-change.txt'), 'new base contract\n')
        await git(f.root, 'add', 'base-change.txt')
        await git(f.root, 'commit', '-m', 'advance base')
        await git(f.root, 'push', 'origin', 'develop')
        expect(await f.runtime.reconcileBase(run)).toBe('merged')
        expect((await f.store.read('run')).stage).toBe('deliver')
        expect(await f.runtime.reconcileBase(run)).toBe('unchanged')
        const action = await new FeatureEngine(f.store, f.runtime).advance('run', 'recovered-driver')
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'feature-review'}})
        const recovered = await f.store.read('run')
        expect(recovered.audit.some((row) => row.event === 'checks executed')).toBe(true)
        expect(recovered.attempts).toEqual({})
        expect(f.deliveries).toHaveLength(0)
    })

    it('preserves a confirmed merge across recovery and rejects stopping a terminal run', async () => {
        const f = await fixture('live')
        await f.engine.advance('run', 'driver')
        const run = await f.store.read('run')
        delete run.in_flight
        run.stage = 'deliver'
        await f.store.write(run)
        f.runtime.mergedDelivery = () =>
            Promise.resolve({
                kind: 'merged',
                number: 7,
                url: 'https://example.invalid/pr/7',
                head: run.accepted_sha,
            })
        f.runtime.reconcileBase = () => Promise.reject(new Error('merged delivery must be observed first'))
        expect(await f.engine.advance('run', 'driver')).toMatchObject({
            kind: 'terminal',
            delivery: {outcome: 'merged', pr_number: 7},
        })
        await expect(f.engine.stop('run')).rejects.toThrow('terminal run')
        expect((await f.store.read('run')).status).toBe('completed')
    })

    it('integrates dependent shared-file slices on one branch and leaves one complete no-ship PR', async () => {
        const f = await fixture()
        let action = await f.engine.advance('run', 'driver')
        const stages: string[] = []
        for (let step = 0; step < 30 && action.kind === 'execute'; step++) {
            stages.push(action.attempt.stage)
            action = await respond(f, action)
        }
        expect(action).toMatchObject({kind: 'terminal', status: 'ready-for-review'})
        expect(stages.filter((stage) => stage === 'implement')).toHaveLength(2)
        expect(stages.filter((stage) => stage === 'slice-review')).toHaveLength(2)
        expect(stages.filter((stage) => stage === 'feature-review')).toHaveLength(1)
        expect(f.deliveries).toHaveLength(1)
        const run = await f.store.read('run')
        expect(run.checkpoints.map((row) => row.task_id)).toEqual(['first', 'second'])
        expect(await readFile(join(run.worktree, 'value.js'), 'utf8')).toContain('value = 2')
        expect(await git(f.root, 'show', 'origin/develop:value.js')).toContain('value = 0')
    }, 30_000)

    it('requires independent evidence for unchanged work, then finishes without an empty PR', async () => {
        const f = await fixture()
        let action = await f.engine.advance('run', 'driver')
        let evaluations = 0
        for (let step = 0; step < 30 && action.kind === 'execute'; step++) {
            if (action.attempt.stage === 'acceptance') {
                evaluations++
            }
            action = await respond(f, action, true)
        }
        expect(action).toMatchObject({kind: 'terminal', status: 'completed', delivery: {outcome: 'no-change'}})
        expect(evaluations).toBe(3)
        expect(f.deliveries).toEqual([])
    }, 30_000)

    it('retains answers, prevents duplicate spawns, and rejects stale results after recovery', async () => {
        const f = await fixture()
        const action = await f.engine.advance('run', 'driver')
        expect(await f.engine.advance('run', 'other-driver')).toMatchObject({kind: 'wait'})
        expect(
            await f.engine.advance(
                'run',
                'driver',
                result(action, {status: 'needs-context', message: 'Which endpoint?'})
            )
        ).toMatchObject({kind: 'park'})
        await f.engine.resume('run', {answer: 'Use the local endpoint'})
        const resumed = await f.engine.advance('run', 'driver')
        expect(resumed.kind === 'execute' && resumed.prompt).toContain('Use the local endpoint')
        await f.engine.stop('run')
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'park'})
        await f.engine.resume('run', {recover: true})
        const recovered = await f.engine.advance('run', 'driver')
        expect(recovered.kind === 'execute' && recovered.prompt).toContain('Use the local endpoint')
        await expect(f.engine.advance('run', 'driver', result(resumed))).rejects.toThrow('stale')
        expect((await f.store.read('run')).answers).toHaveLength(1)
    }, 30_000)
})
