import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
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
import {readBrief} from './test-fixtures.js'

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
        testsOnly: vi.fn().mockResolvedValue(true),
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
type Response = Omit<FeatureResult, 'repaired_spec'> & {repaired_spec?: unknown}
function result(action: FeatureAction, extra: Partial<Response> = {}): Response {
    execution(action)
    return {status: 'done', ...extra}
}
/** Write each role's agent-shaped part (its own claims, no identity) to the in-flight staged paths. */
async function stage(f: Awaited<ReturnType<typeof setup>>, response: Response): Promise<void> {
    const attempt = (await f.store.read('run')).in_flight
    if (!attempt) {
        throw new Error('nothing in flight')
    }
    for (const [role, path] of Object.entries(await f.store.stage('run', attempt))) {
        const {reviews, ...rest} = response
        const part = reviews ? {...rest, claims: reviews.find((row) => row.reviewer === role)?.claims} : rest
        await writeFile(path, JSON.stringify(part))
    }
}
async function submit(f: Awaited<ReturnType<typeof setup>>, response: Response): Promise<FeatureAction> {
    await stage(f, response)
    return f.engine.advance('run', 'driver')
}
const claim = {
    id: 'quality-reviewer.1',
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
    it('reads a pre-batching state.json that has no confirmed_claims field', async () => {
        const f = await setup()
        const path = join(f.input.root, 'runs-v2', 'run', 'state.json')
        const {confirmed_claims: _dropped, ...legacy} = JSON.parse(await readFile(path, 'utf8')) as Record<
            string,
            unknown
        >
        await writeFile(path, JSON.stringify(legacy))
        expect((await f.store.read('run')).confirmed_claims).toEqual([])
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
        expect(await readBrief(action)).not.toContain('Refuted claims')
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
    it('confirms claims in batches of two and repairs from the accumulated blockers', async () => {
        const f = await setup('task-review')
        const ids = async (action: FeatureAction) =>
            [...(await readBrief(action)).matchAll(/^### (\S+)$/gm)].map((match) => match[1])
        let action = await f.engine.advance('run', 'driver')
        const [one, two, three] = ['quality-reviewer.1', 'quality-reviewer.2', 'quality-reviewer.3'] as const
        const claims = [one, two, three].map((id) => ({...claim, id}))
        action = await submit(
            f,
            result(action, {
                reviews: [{reviewer: 'quality-reviewer', claims}],
            })
        )
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'confirm', roles: ['finding-verifier']}})
        expect(await ids(action)).toEqual([one, two])
        expect(await readBrief(action)).toContain(
            `- File: value.ts:1\n- Quote: \`\`\`\n${claim.quote}\n\`\`\`\n- Claim: ${claim.claim}`
        )
        // Votes for the wrong subset park; recovery with the right ids proceeds.
        await stage(
            f,
            result(action, {
                confirmations: [
                    {id: one, confirmed: true, evidence: 'Checked value.ts at the cited statement'},
                    {id: three, confirmed: true, evidence: 'Checked value.ts at the cited statement'},
                ],
            })
        )
        expect(await f.engine.advance('run', 'driver')).toMatchObject({
            kind: 'park',
            reason: expect.stringContaining('confirmation is incomplete') as string,
        })
        await stage(
            f,
            result(action, {
                confirmations: [
                    {id: one, confirmed: true, evidence: 'Checked value.ts at the cited statement'},
                    {id: two, confirmed: false, evidence: 'The cited statement is unreachable'},
                ],
            })
        )
        await f.engine.resume('run', {recover: true})
        action = await f.engine.advance('run', 'driver')
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'confirm', roles: ['finding-verifier']}})
        expect(await ids(action)).toEqual([three])
        expect(await readBrief(action)).not.toContain('Refuted claims')
        expect((await f.store.read('run')).confirmed_claims.map((row) => row.id)).toEqual([one])
        expect(f.runtime.snapshot.mock.calls).toHaveLength(3)
        action = await submit(
            f,
            result(action, {
                confirmations: [{id: three, confirmed: true, evidence: 'Checked value.ts at the cited statement'}],
            })
        )
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'implement'}})
        expect(await readBrief(action)).toContain('value.ts:1: Returns the wrong value')
        const run = await f.store.read('run')
        expect(run.feedback).toHaveLength(2)
        expect(run.confirmed_claims).toEqual([])
        expect(run.claims).toEqual([])
        expect(run.audit.filter((row) => row.event === 'findings confirmed')).toHaveLength(2)
    })
    it.each(['citation', 'missing-claims'] as const)('rejects invalid review evidence: %s', async (kind) => {
        const f = await setup('task-review')
        if (kind === 'citation') {
            vi.mocked(f.runtime.citation).mockResolvedValue(false)
        }
        const action = await f.engine.advance('run', 'driver')
        const response =
            kind === 'citation'
                ? result(action, {reviews: [{reviewer: 'quality-reviewer', claims: [claim]}]})
                : result(action)
        expect(await submit(f, response)).toMatchObject({
            kind: 'park',
            reason: expect.stringContaining(
                kind === 'citation' ? 'invalid citation' : 'missing or duplicate'
            ) as string,
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
        expect(await readBrief(action)).toContain('## Feedback to address\n\n- Fix the remaining contract')
        // A full FeatureSpec is not the repair contract: the staged file is rejected, never consumed.
        expect(await submit(f, result(action, {repaired_spec: spec}))).toMatchObject({
            kind: 'wait',
            reason: expect.stringContaining('staged file rejected (spec-generator: repaired_spec') as string,
        })
        const repair = {specMd: 'Use the corrected contract.', slug: 'values', tasks: spec.tasks}
        await stage(f, result(action, {repaired_spec: repair}))
        action = await f.engine.advance('run', 'driver')
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'spec-review'}})
        expect(await readBrief(action)).toContain('Use the corrected contract.')
        action = await submit(f, result(action))
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'implement'}})
        const revised = {...spec, revision: 2, spec_md: 'Use the corrected contract.'}
        const run = await f.store.read('run')
        expect(run.spec).toEqual(validateFeatureSpec(revised))
        expect(run.spec_digest).toBe(digest(validateFeatureSpec(revised)))
    })
    it('refuses a spec repair that changes accepted work', async () => {
        const f = await setup('spec-repair')
        const run = await f.store.read('run')
        run.checkpoints = [{task_id: 'value', head_sha: sha, spec_digest: run.spec_digest}]
        await f.store.write(run)
        const action = await f.engine.advance('run', 'driver')
        const revised = {
            specMd: spec.spec_md,
            slug: 'values',
            tasks: [{...at(spec.tasks, 0), title: 'Changed accepted task'}],
        }
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
            if (kind === 'wrong-head') {
                vi.mocked(f.runtime.head).mockResolvedValue(nextSha)
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
    it.each([
        ['tests', 'test-writer', '"status"'],
        ['implement', 'implementer', '## Current task'],
        ['task-review', 'quality-reviewer', '"claims"'],
        ['slice-review', 'database-design-reviewer', '"claims"'],
        ['feature-review', 'systemic-failure-reviewer', '"claims"'],
        ['confirm', 'finding-verifier', '"confirmations"'],
        ['acceptance', 'acceptance-evaluator', '"acceptance"'],
        ['spec-repair', 'spec-generator', '"repaired_spec"'],
        ['spec-review', 'spec-reviewer', '## Proposed spec'],
        ['docs', 'scribe', '## Feature range'],
        ['e2e-author', 'e2e-author', '## PRD'],
    ] as const)('writes one identity-free brief per role at %s', async (stage, role, marker) => {
        const f = await setup(stage)
        vi.mocked(f.runtime.databaseChanged).mockResolvedValue(true)
        vi.mocked(f.runtime.exempt).mockResolvedValue(false)
        const run = await f.store.read('run')
        run.claims = [claim]
        run.after_confirm = 'task-review'
        run.repaired_spec = {...spec, revision: 2}
        await f.store.write(run)
        const action = execution(await f.engine.advance('run', 'driver'))
        expect(action.attempt.stage).toBe(stage)
        expect(Object.keys(action.prompts)).toEqual(action.attempt.roles)
        expect(action.attempt.roles).toContain(role)
        for (const each of action.attempt.roles) {
            const brief = await readBrief(action, each)
            expect(brief).toContain(`- Role: ${each}\n- Stage: ${stage}\n- Worktree: ${action.attempt.worktree}`)
            expect(brief).toContain('## Result contract')
            for (const banned of ['Identity', 'attempt_id', 'spec_digest', 'head_sha', action.attempt.id]) {
                expect(brief).not.toContain(banned)
            }
        }
        const brief = await readBrief(action, role)
        expect(brief).toContain(marker)
        const reviewRange = `git -C ${action.attempt.worktree} diff ${action.attempt.base_sha}..${action.attempt.head_sha}`
        if (['tests', 'implement', 'spec-repair', 'spec-review', 'e2e-author', 'confirm'].includes(stage)) {
            expect(brief).not.toContain(reviewRange)
        } else {
            expect(brief).toContain(reviewRange)
        }
    })
    it('lists only refuted claims, with their evidence, in the next reviewer brief', async () => {
        const f = await setup('task-review')
        let action = await f.engine.advance('run', 'driver')
        const refuted = {...claim, id: 'quality-reviewer.2', claim: 'Drops the error path'}
        action = await submit(f, result(action, {reviews: [{reviewer: 'quality-reviewer', claims: [claim, refuted]}]}))
        expect(await readBrief(action)).not.toContain('Refuted claims')
        action = await submit(
            f,
            result(action, {
                confirmations: [
                    {id: claim.id, confirmed: true, evidence: 'Checked value.ts at the cited statement'},
                    {id: refuted.id, confirmed: false, evidence: 'The error path is handled by the caller'},
                ],
            })
        )
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'implement'}})
        action = await submit(f, result(action))
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'task-review'}})
        const brief = await readBrief(action)
        expect(brief).toContain(
            '## Refuted claims\n\nIndependent verifiers refuted these earlier claims. Re-file one only with new evidence, and state that evidence in the `claim`.\n\n- value.ts:1: Drops the error path — refuted: The error path is handled by the caller'
        )
        expect(brief).not.toContain('Returns the wrong value')
    })
})
