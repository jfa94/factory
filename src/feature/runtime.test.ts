import {describe, expect, it, vi} from 'vitest'
import {defaultConfig} from '../config/schema.js'
import type {ExecResult} from '../shared/exec.js'
import {LocalFeatureRuntime} from './runtime.js'
import {FeatureRunSchema} from './schema.js'

const sha = 'a'.repeat(40)
const run = FeatureRunSchema.parse({
    version: 2,
    run_id: 'run',
    repo: 'owner/repo',
    root: '/repo',
    branch: 'factory/1-run',
    worktree: '/repo/feature',
    base_branch: 'develop',
    remote: 'origin',
    ship_mode: 'live',
    debug: false,
    e2e: false,
    ignore_quota: false,
    status: 'running',
    stage: 'deliver',
    task_index: 0,
    accepted_sha: sha,
    task_base_sha: sha,
    slice_base_sha: sha,
    attempts: {},
    checkpoints: [],
    answers: [],
    feedback: [],
    claims: [],
    candidate_satisfied: false,
    delivery: {},
    audit: [],
    spec_digest: 'fixture',
    spec: {
        version: 2,
        revision: 1,
        base_sha: sha,
        contracts: {},
        spec_md: 'Return a value.',
        prd: {issue_number: 1, title: 'Value', body: '- Return a value.', labels: [], body_truncated: false},
        tasks: [
            {
                task_id: 'value',
                slice_id: 'slice',
                requirement_ids: ['R1'],
                title: 'Return value',
                description: 'Return a value.',
                files: ['value.ts'],
                acceptance_criteria: ['Return a value.'],
                tests_to_write: ['Assert a value.'],
                depends_on: [],
                risk_tier: 'low',
                risk_rationale: 'Local behavior',
            },
        ],
    },
})
const response = (stdout = '', code = 0, truncated = false): ExecResult => ({
    stdout,
    code,
    truncated,
    stderr: '',
    signal: null,
})
const reply = (...args: Parameters<typeof response>) => Promise.resolve(response(...args))
const pr = {number: 1, url: 'https://example.invalid/1', state: 'OPEN', headRefOid: sha, baseRefName: 'develop'}

function setup() {
    const command = vi.fn((_name: string, args: readonly string[]) => reply(args[0] === 'rev-parse' ? sha : ''))
    const usage = {read: vi.fn().mockResolvedValue({kind: 'unavailable', reason: 'usage-cache-missing'})}
    return {command, usage, runtime: new LocalFeatureRuntime(defaultConfig(), usage, command)}
}
describe('feature runtime external evidence', () => {
    it.each([
        [[pr, pr], 'multiple'],
        [[{...pr, state: 'CLOSED'}], 'closed'],
        [[{...pr, state: 'MERGED', headRefOid: 'b'.repeat(40)}], 'reviewed HEAD'],
    ])('refuses ambiguous or incompatible existing PRs: %j', async (prs, error) => {
        const f = setup()
        f.command.mockImplementation((name) => reply(name === 'gh' ? JSON.stringify(prs) : sha))
        await expect(f.runtime.deliver(run)).rejects.toThrow(error)
        expect(f.command.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false)
    })
    it.each(['missing', 'unreported', 'failed', 'pending', 'merged', 'changed', 'unavailable', 'truncated'])(
        'observes required CI and merge truth: %s',
        async (scenario) => {
            const f = setup()
            let mergeRequested = false
            f.command.mockImplementation((name, args) => {
                if (name === 'git') {
                    return reply(args[0] === 'rev-parse' ? sha : '')
                }
                if (args[1] === 'list') {
                    return reply(
                        JSON.stringify([
                            {
                                ...pr,
                                state: mergeRequested && scenario === 'merged' ? 'MERGED' : 'OPEN',
                                headRefOid: mergeRequested && scenario === 'changed' ? 'b'.repeat(40) : sha,
                            },
                        ])
                    )
                }
                if (args[1] === 'checks') {
                    if (scenario === 'unreported') {
                        return reply('', 1)
                    }
                    return reply(
                        JSON.stringify(
                            scenario === 'missing'
                                ? []
                                : [
                                      {
                                          name: 'Quality',
                                          bucket:
                                              scenario === 'failed'
                                                  ? 'fail'
                                                  : scenario === 'pending'
                                                    ? 'pending'
                                                    : 'pass',
                                      },
                                  ]
                        ),
                        scenario === 'unavailable' ? 2 : 0,
                        scenario === 'truncated'
                    )
                }
                if (args[1] === 'merge') {
                    mergeRequested = true
                    return reply()
                }
                throw new Error('unexpected command')
            })
            if (['changed', 'unavailable', 'truncated'].includes(scenario)) {
                await expect(f.runtime.deliver(run)).rejects.toThrow()
            } else {
                expect(await f.runtime.deliver(run)).toMatchObject({
                    kind: scenario === 'merged' ? 'merged' : scenario === 'failed' ? 'failed' : 'pending',
                })
            }
            expect(mergeRequested).toBe(['merged', 'changed'].includes(scenario))
        }
    )
    it('recognizes an already merged reviewed PR without pushing again', async () => {
        const f = setup()
        f.command.mockImplementation((name) => reply(name === 'gh' ? JSON.stringify([{...pr, state: 'MERGED'}]) : sha))
        expect(await f.runtime.deliver(run)).toMatchObject({kind: 'merged', head: sha})
        expect(await f.runtime.mergedDelivery(run)).toMatchObject({kind: 'merged', head: sha})
        expect(f.command.mock.calls.some(([, args]) => args[0] === 'push')).toBe(false)
    })
    it('rejects a merged PR at another HEAD and treats no merged PR as absent', async () => {
        const f = setup()
        f.command.mockImplementation((name) => reply(name === 'gh' ? '[]' : sha))
        expect(await f.runtime.mergedDelivery(run)).toBeUndefined()
        f.command.mockImplementation((name) =>
            reply(name === 'gh' ? JSON.stringify([{...pr, headRefOid: 'b'.repeat(40)}]) : sha)
        )
        await expect(f.runtime.mergedDelivery(run)).rejects.toThrow('differs')
    })
    it('preserves active merge conflicts and surfaces unrelated merge failures', async () => {
        const f = setup()
        f.command.mockImplementation((_name, args) => {
            if (args[0] === 'merge-base') {
                return reply('', 1)
            }
            if (args[0] === 'merge') {
                return reply('merge failed', 1)
            }
            if (args[0] === 'diff') {
                return reply('value.ts')
            }
            return reply(sha)
        })
        expect(await f.runtime.reconcileBase(run)).toBe('conflict')
        expect(f.command.mock.calls.some(([, args]) => args.includes('--abort'))).toBe(false)
        f.command.mockImplementation((_name, args) =>
            reply('', ['merge-base', 'merge'].includes(args[0] ?? '') ? 1 : 0)
        )
        await expect(f.runtime.reconcileBase(run)).rejects.toThrow('base integration failed')
    })
    it('rejects failed/truncated Git evidence rather than interpreting absence', async () => {
        const f = setup()
        f.command.mockResolvedValue(response('', 2))
        await expect(f.runtime.ancestor('/repo', sha, sha)).rejects.toThrow('ancestry')
        await expect(f.runtime.noChanges(run)).rejects.toThrow()
        f.command.mockResolvedValue(response('partial', 0, true))
        await expect(f.runtime.head('/repo')).rejects.toThrow('failed')
    })
    it('checks citations against committed source and detects database changes', async () => {
        const f = setup()
        f.command.mockResolvedValue(response('first line\nreturn requestedValue\nlast line'))
        const claim = {
            id: 'c',
            reviewer: 'quality-reviewer',
            severity: 'important' as const,
            file: 'value.ts',
            line: 2,
            quote: 'return requestedValue',
            claim: 'Wrong value',
        }
        expect(await f.runtime.citation('/repo', claim)).toBe(true)
        expect(await f.runtime.citation('/repo', {...claim, quote: 'not present in source'})).toBe(false)
        expect(await f.runtime.citation('/repo', {...claim, file: '../outside'})).toBe(false)
        f.command.mockResolvedValue(response('supabase/migrations/001.sql'))
        expect(await f.runtime.databaseChanged(run, sha)).toBe(true)
    })
    it('uses quota evidence unless the run explicitly overrides it', async () => {
        const f = setup()
        expect(await f.runtime.quota({...run, ignore_quota: true})).toBeUndefined()
        expect(f.usage.read).not.toHaveBeenCalled()
        expect(await f.runtime.quota(run)).toBeDefined()
        expect(f.usage.read).toHaveBeenCalledOnce()
    })
    it('validates spec repair against the unchanged PRD', async () => {
        const f = setup()
        await expect(f.runtime.validateRepair(run, {...run.spec, tasks: []})).rejects.toThrow()
        await expect(f.runtime.validateRepair(run, run.spec)).resolves.toBeUndefined()
    })
})
