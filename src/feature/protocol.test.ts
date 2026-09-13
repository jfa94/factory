import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {FeatureEngine} from './engine.js'
import {FeatureStore} from './store.js'
import {
    digest,
    validateFeatureSpec,
    type FeatureAction,
    type FeatureResult,
    type FeatureSpec,
    type Stage,
} from './schema.js'
import type {FeatureRuntime} from './ports.js'
import {at} from '../shared/assert.js'

const dirs: string[] = []
const sha = 'a'.repeat(40)
const nextSha = 'b'.repeat(40)
afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        await rm(dir, {recursive: true})
    }
})
const spec: FeatureSpec = {
    version: 2,
    revision: 1,
    base_sha: sha,
    contracts: {'AGENTS.md': 'Keep contracts'},
    prd: {issue_number: 1, title: 'Values', body: '- Return a value.', labels: [], body_truncated: false},
    spec_md: 'Deliver a value.',
    tasks: [
        {
            task_id: 'value',
            slice_id: 'slice',
            requirement_ids: ['R1'],
            title: 'Return value',
            description: 'Return the specified value.',
            files: ['value.ts'],
            acceptance_criteria: ['Return the value.'],
            tests_to_write: ['Assert the value.'],
            depends_on: [],
            risk_tier: 'low',
            risk_rationale: 'Local behavior',
        },
    ],
}

async function setup(stage?: Stage) {
    const dir = await mkdtemp(join(tmpdir(), 'feature-protocol-'))
    dirs.push(dir)
    const runtime = {
        ciWaitMinutes: 1,
        now: () => '2026-09-07T00:00:00Z',
        prepare: vi.fn().mockResolvedValue(undefined),
        head: vi.fn().mockResolvedValue(sha),
        clean: vi.fn().mockResolvedValue(true),
        ancestor: vi.fn().mockResolvedValue(true),
        exempt: vi.fn().mockResolvedValue(true),
        checks: vi.fn().mockResolvedValue({passed: true, observed: 1, details: [], assertionFailure: false}),
        snapshot: vi.fn().mockResolvedValue(join(dir, 'snapshot')),
        citation: vi.fn().mockResolvedValue(true),
        databaseChanged: vi.fn().mockResolvedValue(false),
        quota: vi.fn().mockResolvedValue(undefined),
        reconcileBase: vi.fn().mockResolvedValue('unchanged'),
        noChanges: vi.fn().mockResolvedValue(false),
        mergedDelivery: vi.fn().mockResolvedValue(undefined),
        deliver: vi.fn().mockResolvedValue({kind: 'merged', number: 1, url: 'https://example.invalid/1', head: sha}),
        validateRepair: vi.fn().mockResolvedValue(undefined),
    } satisfies FeatureRuntime
    const store = new FeatureStore(dir),
        engine = new FeatureEngine(store, runtime)
    const input = {
        runId: 'run',
        repo: 'owner/repo',
        root: dir,
        spec: structuredClone(spec),
        baseBranch: 'develop',
        remote: 'origin',
    }
    const run = await engine.create(input)
    if (stage) {
        run.stage = stage
        await store.write(run)
    }
    return {engine, store, runtime, input}
}
function execution(action: FeatureAction) {
    if (action.kind !== 'execute') {
        throw new Error(`expected execute, got ${action.kind}`)
    }
    return action
}
function result(action: FeatureAction, extra: Partial<FeatureResult> = {}): FeatureResult {
    const {attempt} = execution(action)
    return {
        attempt_id: attempt.id,
        spec_digest: attempt.spec_digest,
        head_sha: attempt.head_sha,
        status: 'done',
        ...extra,
    }
}
/** Write a merged result verbatim to the in-flight attempt's per-role staged paths. */
async function stage(f: Awaited<ReturnType<typeof setup>>, response: FeatureResult): Promise<void> {
    const attempt = (await f.store.read('run')).in_flight
    if (!attempt) {
        throw new Error('nothing in flight')
    }
    for (const [role, path] of Object.entries(await f.store.stage('run', attempt))) {
        const part = response.reviews
            ? {...response, reviews: response.reviews.filter((row) => row.reviewer === role)}
            : response
        await writeFile(path, JSON.stringify(part))
    }
}
async function submit(f: Awaited<ReturnType<typeof setup>>, response: FeatureResult): Promise<FeatureAction> {
    await stage(f, response)
    return f.engine.advance('run', 'driver')
}
const claim = {
    id: 'claim',
    reviewer: 'quality-reviewer',
    severity: 'important' as const,
    file: 'value.ts',
    line: 1,
    quote: 'return wrongValue',
    claim: 'Returns the wrong value',
}

describe('feature evidence and recovery protocol', () => {
    it('keeps an explicit stop sticky across quota recovery and permits cancellation', async () => {
        const f = await setup()
        vi.mocked(f.runtime.quota).mockResolvedValue('weekly quota')
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'wait'})
        await f.engine.stop('run')
        vi.mocked(f.runtime.quota).mockResolvedValue(undefined)
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'park'})
        expect(f.runtime.prepare).not.toHaveBeenCalled()
        await f.engine.resume('run', {cancel: true})
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'terminal', status: 'cancelled'})
        await expect(f.engine.resume('run')).rejects.toThrow('fresh run')
    })
    it('rejects duplicate runs and a second producer for the repository', async () => {
        const f = await setup()
        await expect(f.engine.create(f.input)).rejects.toThrow('already exists')
        await expect(f.engine.create({...f.input, runId: 'second'})).rejects.toThrow('active run')
        await expect(f.engine.advance('run', ' ')).rejects.toThrow('driver session')
    })
    it('requires an answer for pending context and refuses unrelated or empty answers', async () => {
        const f = await setup()
        await expect(f.engine.resume('run', {answer: 'unrelated'})).rejects.toThrow('pending question')
        const action = await f.engine.advance('run', 'driver')
        await submit(f, result(action, {status: 'needs-context', message: 'Which value?'}))
        await expect(f.engine.resume('run')).rejects.toThrow('answer required')
        await expect(f.engine.resume('run', {answer: ' '})).rejects.toThrow('nonempty')
        expect((await f.engine.resume('run', {answer: 'Use 5'})).answers).toMatchObject([{answer: 'Use 5'}])
    })
    it.each([true, false])('independently confirms a finding before choosing repair: %s', async (confirmed) => {
        const f = await setup('task-review')
        let action = await f.engine.advance('run', 'driver')
        action = await submit(f, result(action, {reviews: [{reviewer: 'quality-reviewer', claims: [claim]}]}))
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'confirm', roles: ['finding-verifier']}})
        expect(execution(action).prompt).not.toContain('prior_reviews')
        expect(await submit(f, result(action, {confirmations: []}))).toMatchObject({
            kind: 'park',
            reason: expect.stringContaining('confirmation is incomplete') as string,
        })
        // The invalid staged file stays in place; a corrected one is consumed by explicit recovery.
        await stage(
            f,
            result(action, {
                confirmations: [{id: claim.id, confirmed, evidence: 'Checked value.ts at the cited statement'}],
            })
        )
        await f.engine.resume('run', {recover: true})
        action = await f.engine.advance('run', 'driver')
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: confirmed ? 'implement' : 'slice-review'}})
        expect((await f.store.read('run')).checkpoints).toHaveLength(confirmed ? 0 : 1)
    })
    it.each(['citation', 'reviewer', 'duplicate'] as const)('rejects invalid review evidence: %s', async (kind) => {
        const f = await setup('task-review')
        if (kind === 'citation') {
            vi.mocked(f.runtime.citation).mockResolvedValue(false)
        }
        const action = await f.engine.advance('run', 'driver')
        const claims =
            kind === 'duplicate'
                ? [claim, claim]
                : [{...claim, reviewer: kind === 'reviewer' ? 'other' : claim.reviewer}]
        expect(await submit(f, result(action, {reviews: [{reviewer: 'quality-reviewer', claims}]}))).toMatchObject({
            kind: 'park',
        })
        expect((await f.store.read('run')).checkpoints).toEqual([])
    })
    it('requires complete acceptance and repairs unmet feature criteria', async () => {
        const f = await setup('acceptance')
        const action = await f.engine.advance('run', 'driver')
        expect(await submit(f, result(action, {acceptance: []}))).toMatchObject({
            kind: 'park',
            reason: expect.stringContaining('every requested criterion') as string,
        })
        await stage(
            f,
            result(action, {
                acceptance: [
                    {id: 'R1', met: false, evidence: 'The value is wrong in value.ts'},
                    {id: 'value:AC1', met: true, evidence: 'The public function returns a value'},
                ],
            })
        )
        await f.engine.resume('run', {recover: true})
        const repaired = await f.engine.advance('run', 'driver')
        expect(repaired).toMatchObject({kind: 'execute', attempt: {stage: 'implement'}})
        const next = await submit(f, result(repaired))
        expect(next).toMatchObject({kind: 'execute', attempt: {stage: 'feature-review'}})
    })
    it('revises a defective spec independently and preserves the accepted prefix', async () => {
        const f = await setup('implement')
        let action = await f.engine.advance('run', 'driver')
        action = await submit(f, result(action, {status: 'spec-defect', message: 'Fix the remaining contract'}))
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'spec-repair'}})
        expect(execution(action).prompt).toContain('"revision": 1')
        expect(await submit(f, result(action, {repaired_spec: spec}))).toMatchObject({
            kind: 'park',
            reason: expect.stringContaining('increment revision') as string,
        })
        const revised = {...spec, revision: 2, spec_md: 'Use the corrected contract.'}
        await stage(f, result(action, {repaired_spec: revised}))
        await f.engine.resume('run', {recover: true})
        action = await f.engine.advance('run', 'driver')
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'spec-review'}})
        expect(execution(action).prompt).toContain('Use the corrected contract.')
        action = await submit(f, result(action))
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'implement'}})
        expect((await f.store.read('run')).spec_digest).toBe(digest(validateFeatureSpec(revised)))
    })
    it('refuses a spec repair that changes accepted work', async () => {
        const f = await setup('spec-repair')
        const run = await f.store.read('run')
        run.checkpoints = [{task_id: 'value', head_sha: sha, spec_digest: run.spec_digest}]
        await f.store.write(run)
        const action = await f.engine.advance('run', 'driver')
        const revised = {...spec, revision: 2, tasks: [{...at(spec.tasks, 0), title: 'Changed accepted task'}]}
        expect(await submit(f, result(action, {repaired_spec: revised}))).toMatchObject({
            kind: 'park',
            reason: expect.stringContaining('accepted task prefix') as string,
        })
    })
    it('adds database review and authors e2e only when requested', async () => {
        const f = await setup('docs')
        const run = await f.store.read('run')
        run.e2e = true
        await f.store.write(run)
        vi.mocked(f.runtime.databaseChanged).mockResolvedValue(true)
        let action = await f.engine.advance('run', 'driver')
        action = await submit(f, result(action))
        expect(action).toMatchObject({kind: 'execute', attempt: {roles: ['e2e-author']}})
        action = await submit(f, result(action))
        expect(execution(action).attempt.roles).toContain('database-design-reviewer')
    })
    it.each(['dirty', 'removed-commit', 'wrong-head', 'snapshot'] as const)(
        'rejects invalid worktree evidence: %s',
        async (kind) => {
            const f = await setup('task-review')
            const action = await f.engine.advance('run', 'driver')
            if (kind === 'dirty') {
                vi.mocked(f.runtime.clean).mockResolvedValue(false)
            }
            if (kind === 'removed-commit') {
                vi.mocked(f.runtime.ancestor).mockResolvedValue(false)
            }
            if (kind === 'snapshot') {
                vi.mocked(f.runtime.clean).mockImplementation((path: string) =>
                    Promise.resolve(path !== execution(action).attempt.worktree)
                )
            }
            expect(
                await submit(
                    f,
                    result(action, {
                        head_sha: kind === 'wrong-head' ? nextSha : sha,
                        reviews: [{reviewer: 'quality-reviewer', claims: []}],
                    })
                )
            ).toMatchObject({kind: 'park'})
            expect((await f.store.read('run')).in_flight?.id).toBe(execution(action).attempt.id)
        }
    )
    it('repairs CI failures and preserves merge conflicts for forward repair', async () => {
        const f = await setup('deliver')
        const run = await f.store.read('run')
        run.verified_feature = {head_sha: sha, spec_digest: run.spec_digest}
        await f.store.write(run)
        vi.mocked(f.runtime.deliver).mockResolvedValue({
            kind: 'failed',
            number: 1,
            url: 'url',
            head: sha,
            reason: 'CI failed',
        })
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'execute', attempt: {stage: 'implement'}})
        expect((await f.store.read('run')).feedback).toEqual(['CI failed'])
        await f.engine.resume('run', {recover: true})
        const restored = await f.store.read('run')
        restored.stage = 'deliver'
        await f.store.write(restored)
        vi.mocked(f.runtime.reconcileBase).mockResolvedValue('conflict')
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'execute', attempt: {stage: 'implement'}})
        expect((await f.store.read('run')).feedback[0]).toContain('active merge conflict')
    })
})
