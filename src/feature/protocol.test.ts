import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
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
    type FeatureRun,
    type FeatureSpec,
    type Stage,
} from './schema.js'
import {TransientFailure, type FeatureRuntime} from './ports.js'
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
    let snapshots = 0
    const runtime = {
        ciWaitMinutes: 1,
        now: () => '2026-09-07T00:00:00Z',
        prepare: vi.fn().mockResolvedValue(undefined),
        head: vi.fn().mockResolvedValue(sha),
        clean: vi.fn().mockResolvedValue(true),
        ancestor: vi.fn().mockResolvedValue(true),
        exempt: vi.fn().mockResolvedValue(true),
        checks: vi.fn().mockResolvedValue({passed: true, observed: 1, details: []}),
        testsOnly: vi.fn().mockResolvedValue(true),
        // ponytail: real snapshot paths embed the attempt id; a counter keeps the identity-free brief check meaningful.
        snapshot: vi.fn((_run: FeatureRun) =>
            Promise.resolve(join(dir, '.claude', 'worktrees', `review-run-${++snapshots}`))
        ),
        removeSnapshot: vi.fn().mockResolvedValue(undefined),
        featureBase: vi.fn().mockResolvedValue(sha),
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
        vi.mocked(f.runtime.quota).mockResolvedValue({reason: 'weekly quota', seconds: 60})
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'wait'})
        await f.engine.stop('run')
        vi.mocked(f.runtime.quota).mockResolvedValue(undefined)
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'park'})
        expect(f.runtime.prepare).not.toHaveBeenCalled()
        await f.engine.resume('run', {cancel: true})
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'terminal', status: 'cancelled'})
        await expect(f.engine.resume('run')).rejects.toThrow('fresh run')
    })
    it('waits the runtime-computed quota boundary and re-advances a saved checkpoint immediately', async () => {
        const f = await setup()
        vi.mocked(f.runtime.quota).mockResolvedValueOnce({reason: '5h quota over curve', seconds: 1234})
        expect(await f.engine.advance('run', 'driver')).toEqual({
            kind: 'wait',
            run_id: 'run',
            reason: '5h quota over curve',
            retry_after_seconds: 1234,
        })
        // ponytail: twelve no-action steps are unreachable with the fake runtime, so stub the step.
        vi.spyOn(f.engine as unknown as {step: () => Promise<undefined>}, 'step').mockResolvedValue(undefined)
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'wait', retry_after_seconds: 0})
    })
    it('delivers a verified feature without waiting on quota: delivery dispatches no agent', async () => {
        const f = await setup('deliver')
        const run = await f.store.read('run')
        await f.store.write({...run, verified_feature: {head_sha: sha, spec_digest: run.spec_digest}})
        vi.mocked(f.runtime.quota).mockResolvedValue({reason: '5h quota over curve', seconds: 1234})
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'terminal', status: 'completed'})
    })
    it('rechecks quota before work that leaves the deliver stage', async () => {
        const f = await setup('deliver')
        vi.mocked(f.runtime.quota).mockResolvedValue({reason: '5h quota over curve', seconds: 1234})
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'wait', retry_after_seconds: 1234})
        expect((await f.store.read('run')).stage).toBe('feature-check')
        expect(f.runtime.checks).not.toHaveBeenCalled()
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
        // User decision 3: self-heal. Only a spec-loop question parks for an answer.
        const f = await setup('spec-repair')
        await expect(f.engine.resume('run', {answer: 'unrelated'})).rejects.toThrow('pending question')
        const action = await f.engine.advance('run', 'driver')
        await submit(f, result(action, {status: 'needs-context', message: 'Which value?'}))
        await expect(f.engine.resume('run')).rejects.toThrow('answer required')
        await expect(f.engine.resume('run', {answer: ' '})).rejects.toThrow('nonempty')
        expect((await f.engine.resume('run', {answer: 'Use 5'})).answers).toMatchObject([{answer: 'Use 5'}])
    })
    it('routes a producer question to spec repair with the asking role in the spec brief', async () => {
        const f = await setup('implement')
        const action = await f.engine.advance('run', 'driver')
        const next = await submit(f, result(action, {status: 'needs-context', message: 'Which value?'}))
        expect(next).toMatchObject({kind: 'execute', attempt: {stage: 'spec-repair', roles: ['spec-generator']}})
        expect(await readBrief(next)).toContain('implementer needs context: Which value?')
        const run = await f.store.read('run')
        expect(run.attempts.spec).toBe(1)
        expect(run.question).toBeUndefined()
    })
    it('routes a panel reviewer question to spec repair and drops the panel claims', async () => {
        const f = await setup('slice-review')
        const action = execution(await f.engine.advance('run', 'driver'))
        for (const [role, path] of Object.entries(action.staged)) {
            const part =
                role === 'silent-failure-hunter'
                    ? {status: 'needs-context', message: 'Is a retry intended?'}
                    : {status: 'done', claims: [{...claim, reviewer: undefined, id: undefined}]}
            await writeFile(path, JSON.stringify(part))
        }
        const next = await f.engine.advance('run', 'driver')
        expect(next).toMatchObject({kind: 'execute', attempt: {stage: 'spec-repair'}})
        expect(await readBrief(next)).toContain('silent-failure-hunter needs context: Is a retry intended?')
        expect((await f.store.read('run')).claims).toEqual([])
    })
    it('parks a spec-review question for an operator answer', async () => {
        const f = await setup('spec-review')
        const action = await f.engine.advance('run', 'driver')
        expect(await submit(f, result(action, {status: 'needs-context', message: 'Which tenant?'}))).toMatchObject({
            kind: 'park',
        })
        const run = await f.store.read('run')
        expect(run.stop_reason?.kind).toBe('context')
        expect(run.question).toBe('Which tenant?')
    })
    it('re-issues a blocked role twice, then parks as an environment failure', async () => {
        const f = await setup('implement')
        const first = execution(await f.engine.advance('run', 'driver'))
        let action: FeatureAction = first
        for (let n = 0; n < 2; n++) {
            action = await submit(f, result(action, {status: 'blocked', message: 'no runner'}))
            expect(action).toMatchObject({kind: 'execute', attempt: {id: first.attempt.id, roles: ['implementer']}})
            expect(await readBrief(action)).toContain('agent reported blocked: no runner; retry')
        }
        expect(await submit(f, result(action, {status: 'blocked', message: 'no runner'}))).toMatchObject({kind: 'park'})
        expect((await f.store.read('run')).stop_reason?.kind).toBe('environment')
    })
    it('parks a blocked spec repair with its question pending', async () => {
        const f = await setup('spec-repair')
        const action = await f.engine.advance('run', 'driver')
        await submit(f, result(action, {status: 'blocked', message: 'Which tenant owns billing?'}))
        const run = await f.store.read('run')
        expect(run.stop_reason?.kind).toBe('spec')
        expect(run.question).toBe('Which tenant owns billing?')
    })
    it('dispatches only the final repair pass on Opus and keeps it across a re-issue', async () => {
        const f = await setup('implement')
        vi.mocked(f.runtime.checks).mockResolvedValue({passed: false, observed: 1, details: ['value test fails']})
        let action = await f.engine.advance('run', 'driver')
        const models: unknown[] = []
        for (let n = 0; n < 3; n++) {
            models.push(execution(action).models)
            action = await submit(f, result(action))
        }
        expect(models).toEqual([undefined, undefined, undefined])
        expect(execution(action)).toMatchObject({
            models: {implementer: 'opus'},
            attempt: {models: {implementer: 'opus'}},
        })
        expect((await f.store.read('run')).audit.filter((row) => row.event === 'model escalated')).toHaveLength(1)
        vi.mocked(f.runtime.clean).mockResolvedValueOnce(false)
        const reissued = await submit(f, result(action))
        expect(reissued).toMatchObject({kind: 'execute', models: {implementer: 'opus'}})
        expect(await submit(f, result(reissued))).toMatchObject({kind: 'park'})
        expect((await f.store.read('run')).final_pass).toBeUndefined()
    })
    it.each([true, false])('independently confirms a finding before choosing repair: %s', async (confirmed) => {
        const f = await setup('task-review')
        let action = await f.engine.advance('run', 'driver')
        action = await submit(f, result(action, {reviews: [{reviewer: 'quality-reviewer', claims: [claim]}]}))
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'confirm', roles: ['finding-verifier']}})
        expect(await readBrief(action)).not.toContain('Refuted claims')
        // Decision 4: an incomplete confirmation is re-issued to the verifier with the reason.
        const reissued = await submit(f, result(action, {confirmations: []}))
        expect(reissued).toMatchObject({
            kind: 'execute',
            attempt: {id: execution(action).attempt.id, roles: ['finding-verifier']},
        })
        expect(await readBrief(reissued)).toContain('confirmation is incomplete')
        action = await submit(
            f,
            result(reissued, {
                confirmations: [{id: claim.id, confirmed, evidence: 'Checked value.ts at the cited statement'}],
            })
        )
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
        // Decision 4: votes for the wrong subset are re-issued; the right ids proceed.
        await stage(
            f,
            result(action, {
                confirmations: [
                    {id: one, confirmed: true, evidence: 'Checked value.ts at the cited statement'},
                    {id: three, confirmed: true, evidence: 'Checked value.ts at the cited statement'},
                ],
            })
        )
        const reissued = await f.engine.advance('run', 'driver')
        expect(reissued).toMatchObject({kind: 'execute', attempt: {stage: 'confirm'}})
        expect(await readBrief(reissued)).toContain('confirmation is incomplete')
        await stage(
            f,
            result(action, {
                confirmations: [
                    {id: one, confirmed: true, evidence: 'Checked value.ts at the cited statement'},
                    {id: two, confirmed: false, evidence: 'The cited statement is unreachable'},
                ],
            })
        )
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
        // Decision 4: the reviewer is re-issued with the reason instead of parking.
        const reissued = await submit(f, response)
        expect(reissued).toMatchObject({
            kind: 'execute',
            attempt: {id: execution(action).attempt.id, roles: ['quality-reviewer']},
        })
        expect(await readBrief(reissued)).toContain(
            kind === 'citation' ? 'invalid citation for quality-reviewer.1 (value.ts:1)' : 'no claims array'
        )
        expect((await f.store.read('run')).checkpoints).toEqual([])
    })
    it('requires complete acceptance and repairs unmet feature criteria', async () => {
        const f = await setup('acceptance')
        const action = await f.engine.advance('run', 'driver')
        const reissued = await submit(f, result(action, {acceptance: []}))
        expect(reissued).toMatchObject({kind: 'execute', attempt: {roles: ['acceptance-evaluator']}})
        expect(await readBrief(reissued)).toContain('every requested criterion exactly once: R1, value:AC1')
        await stage(
            f,
            result(action, {
                acceptance: [
                    {id: 'R1', met: false, evidence: 'The value is wrong in value.ts'},
                    {id: 'value:AC1', met: true, evidence: 'The public function returns a value'},
                ],
            })
        )
        const repaired = await f.engine.advance('run', 'driver')
        expect(repaired).toMatchObject({kind: 'execute', attempt: {stage: 'implement'}})
        // Decision 5: unmet rows scope the feature re-review to the repair, from the HEAD they were judged at.
        expect((await f.store.read('run')).rereview).toEqual({
            boundary: 'feature-review',
            base: sha,
            claims: [{claim: 'R1: The value is wrong in value.ts'}],
        })
        const next = await submit(f, result(repaired))
        expect(next).toMatchObject({kind: 'execute', attempt: {stage: 'feature-review', base_sha: sha}})
        expect(await readBrief(next)).toContain('- R1: The value is wrong in value.ts')
    })
    it('bases feature review and acceptance on the merge-base unless a re-review applies (C5)', async () => {
        const f = await setup('feature-review')
        f.runtime.featureBase.mockResolvedValue(nextSha)
        const action = execution(await f.engine.advance('run', 'driver'))
        expect(action.attempt.base_sha).toBe(nextSha)
        expect(f.runtime.databaseChanged).toHaveBeenCalledWith(expect.anything(), nextSha)
        const accepted = execution(
            await submit(f, result(action, {reviews: action.attempt.roles.map((reviewer) => ({reviewer, claims: []}))}))
        )
        expect(accepted.attempt).toMatchObject({stage: 'acceptance', base_sha: nextSha})
    })
    it('scopes the finding-verifier of a re-review to the repair and clears the scope on pass (decision 5)', async () => {
        const f = await setup('task-review')
        let action = await f.engine.advance('run', 'driver')
        action = await submit(f, result(action, {reviews: [{reviewer: 'quality-reviewer', claims: [claim]}]}))
        expect(await readBrief(action)).not.toContain('Re-review scope')
        const evidence = 'Checked value.ts at the cited statement'
        action = await submit(f, result(action, {confirmations: [{id: claim.id, confirmed: true, evidence}]}))
        action = await submit(f, result(action))
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'task-review'}})
        const second = {...claim, claim: 'Still returns the wrong value'}
        action = await submit(f, result(action, {reviews: [{reviewer: 'quality-reviewer', claims: [second]}]}))
        expect(await readBrief(action)).toContain(
            `Confirm a claim only if it is in or caused by that repair diff, or it is one of these prior claims still unresolved:\n\n- value.ts:1: Returns the wrong value`
        )
        action = await submit(f, result(action, {confirmations: [{id: claim.id, confirmed: false, evidence}]}))
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'slice-review'}})
        expect((await f.store.read('run')).rereview).toBeUndefined()
    })
    it('removes each accepted review snapshot and refuses a path outside the run prefix (D1)', async () => {
        const f = await setup('task-review')
        const outside = join(f.input.root, 'elsewhere')
        f.runtime.snapshot.mockResolvedValueOnce(outside)
        let action = execution(await f.engine.advance('run', 'driver'))
        action = execution(await submit(f, result(action, {reviews: [{reviewer: 'quality-reviewer', claims: []}]})))
        expect(f.runtime.removeSnapshot).not.toHaveBeenCalled()
        expect(
            (await f.store.read('run')).audit.find((row) => row.event === 'snapshot removal failed')?.details
        ).toMatchObject({
            worktree: outside,
            reason: expect.stringContaining('refusing to remove') as string,
        })
        f.runtime.removeSnapshot.mockRejectedValueOnce(new Error('worktree is locked'))
        const slice = action.attempt
        action = execution(
            await submit(f, result(action, {reviews: slice.roles.map((reviewer) => ({reviewer, claims: []}))}))
        )
        expect(f.runtime.removeSnapshot).toHaveBeenCalledWith(expect.anything(), slice.worktree)
        const failed = (await f.store.read('run')).audit.filter((row) => row.event === 'snapshot removal failed')
        expect(failed.at(-1)?.details).toMatchObject({worktree: slice.worktree, reason: 'worktree is locked'})
        expect(action.attempt.stage).not.toBe('slice-review')
    })
    it('removes a modified snapshot once the fresh-snapshot rejection retires it (D1)', async () => {
        const f = await setup('task-review')
        const action = execution(await f.engine.advance('run', 'driver'))
        f.runtime.clean.mockImplementation((path: string) => Promise.resolve(path !== action.attempt.worktree))
        const waited = await submit(f, result(action, {reviews: [{reviewer: 'quality-reviewer', claims: []}]}))
        expect(waited).toMatchObject({kind: 'wait'})
        expect((await f.store.read('run')).in_flight).toBeUndefined()
        expect(f.runtime.removeSnapshot).toHaveBeenCalledWith(expect.anything(), action.attempt.worktree)
    })
    it('marks confirmed claims on test files as tests to strengthen in the implementer brief (decision 6)', async () => {
        const f = await setup('task-review')
        let action = await f.engine.advance('run', 'driver')
        const weak = {
            ...claim,
            id: 'quality-reviewer.2',
            file: 'value.test.ts',
            claim: 'Asserts nothing about the value',
        }
        action = await submit(f, result(action, {reviews: [{reviewer: 'quality-reviewer', claims: [claim, weak]}]}))
        const evidence = 'Checked the cited statement in the file'
        action = await submit(
            f,
            result(action, {
                confirmations: [
                    {id: claim.id, confirmed: true, evidence},
                    {id: weak.id, confirmed: true, evidence},
                ],
            })
        )
        const brief = await readBrief(action)
        expect(brief).toContain('- value.test.ts:1: Asserts nothing about the value (strengthen this test)')
        expect(brief).toContain('- value.ts:1: Returns the wrong value\n')
    })
    it('revises a defective spec independently and preserves the accepted prefix', async () => {
        const f = await setup('implement')
        let action = await f.engine.advance('run', 'driver')
        action = await submit(f, result(action, {status: 'spec-defect', message: 'Fix the remaining contract'}))
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'spec-repair'}})
        expect(await readBrief(action)).toContain('## Feedback to address\n\n- Fix the remaining contract')
        // A full FeatureSpec is not the repair contract: the staged file is rejected and re-issued.
        const reissued = await submit(f, result(action, {repaired_spec: spec}))
        expect(reissued).toMatchObject({kind: 'execute', attempt: {roles: ['spec-generator']}})
        expect(await readBrief(reissued)).toContain('- spec-generator: repaired_spec')
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
    it('restarts a task halted mid-way from its last accepted checkpoint, skipping the baseline', async () => {
        const f = await setup('implement')
        vi.mocked(f.runtime.exempt).mockResolvedValue(false)
        vi.mocked(f.runtime.head).mockResolvedValue(nextSha) // the halted task's RED tests are committed
        let action = await f.engine.advance('run', 'driver')
        action = await submit(f, result(action, {status: 'needs-context', message: 'Which value?'}))
        const repair = {specMd: 'Return 5.', slug: 'values', tasks: spec.tasks}
        action = await submit(f, result(action, {repaired_spec: repair}))
        vi.mocked(f.runtime.checks).mockClear()
        action = await submit(f, result(action))
        expect(action).toMatchObject({kind: 'execute', attempt: {stage: 'tests', roles: ['test-writer']}})
        expect(f.runtime.checks).not.toHaveBeenCalled()
        const run = await f.store.read('run')
        expect(run.task_base_sha).toBe(sha)
        expect(run.claims).toEqual([])
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
        const reissued = await submit(f, result(action, {repaired_spec: revised}))
        expect(reissued).toMatchObject({kind: 'execute', attempt: {roles: ['spec-generator']}})
        expect(await readBrief(reissued)).toContain('accepted task prefix')
        expect((await f.store.read('run')).attempts).toEqual({})
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
            const next = await submit(
                f,
                result(action, {
                    reviews: [{reviewer: 'quality-reviewer', claims: []}],
                })
            )
            if (kind === 'snapshot') {
                // Decision 4: a modified snapshot retires the attempt; the next call issues a fresh one.
                expect(next).toMatchObject({kind: 'wait', retry_after_seconds: 0})
                expect((await f.store.read('run')).in_flight).toBeUndefined()
                const fresh = execution(await f.engine.advance('run', 'driver'))
                expect(fresh.attempt).toMatchObject({stage: 'task-review', roles: ['quality-reviewer']})
                expect(fresh.attempt.id).not.toBe(execution(action).attempt.id)
                expect(f.runtime.snapshot.mock.calls).toHaveLength(2)
                expect(await readBrief(fresh)).toContain('review snapshot was modified')
                return
            }
            expect(next).toMatchObject({kind: 'park'})
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
        // Decision 5: the confirmed claim is no longer absent; it is listed as a prior claim to re-check, never as refuted.
        const [refutedSection = '', rereview = ''] =
            brief.split('## Refuted claims')[1]?.split('## Re-review of a repair') ?? []
        expect(refutedSection).not.toContain('Returns the wrong value')
        expect(rereview).toContain('This is a re-review of a repair.')
        expect(rereview).toContain('- value.ts:1: Returns the wrong value')
    })

    it('re-issues a producer that left uncommitted work, without spending a repair pass', async () => {
        const f = await setup('implement')
        const action = execution(await f.engine.advance('run', 'driver'))
        vi.mocked(f.runtime.clean).mockResolvedValueOnce(false)
        const reissued = await submit(f, result(action))
        expect(reissued).toMatchObject({kind: 'execute', attempt: {id: action.attempt.id, roles: ['implementer']}})
        expect(await readBrief(reissued)).toContain('- uncommitted work remains')
        expect((await f.store.read('run')).rejections).toEqual({
            implementer: ['uncommitted work remains; preserve it and finish the attempt'],
        })
        // Acceptance clears the rejections; repair budgets were never touched.
        expect(await submit(f, result(reissued))).toMatchObject({kind: 'execute', attempt: {stage: 'task-review'}})
        const run = await f.store.read('run')
        expect(run.rejections).toBeUndefined()
        expect(run.attempts).toEqual({})
        expect(run.audit.filter((row) => row.event === 'result rejected')).toHaveLength(1)
    })
    it('re-issues already-satisfied from e2e-author', async () => {
        const f = await setup('e2e-author')
        const action = execution(await f.engine.advance('run', 'driver'))
        const reissued = await submit(f, result(action, {status: 'already-satisfied'}))
        expect(reissued).toMatchObject({kind: 'execute', attempt: {roles: ['e2e-author']}})
        expect(await readBrief(reissued)).toContain('## Previous result rejected')
    })
    it('re-issues a spec repair that fails validation', async () => {
        const f = await setup('spec-repair')
        vi.mocked(f.runtime.validateRepair).mockRejectedValueOnce(new Error('R1 is uncovered'))
        const action = execution(await f.engine.advance('run', 'driver'))
        const repair = {specMd: 'Use the corrected contract.', slug: 'values', tasks: spec.tasks}
        const reissued = await submit(f, result(action, {repaired_spec: repair}))
        expect(reissued).toMatchObject({kind: 'execute', attempt: {roles: ['spec-generator']}})
        expect(await readBrief(reissued)).toContain('- R1 is uncovered')
        expect((await f.store.read('run')).attempts).toEqual({})
    })
    it('re-issues one invalid panel role while the others are still running', async () => {
        const f = await setup('slice-review')
        const action = execution(await f.engine.advance('run', 'driver'))
        const [bad, ...rest] = action.attempt.roles
        await writeFile(action.staged[bad ?? ''] ?? '', 'I found nothing.')
        const reissued = execution(await f.engine.advance('run', 'driver'))
        expect(reissued.attempt).toMatchObject({id: action.attempt.id, roles: [bad]})
        expect(Object.keys(reissued.staged)).toEqual([bad])
        for (const role of rest) {
            await writeFile(action.staged[role] ?? '', JSON.stringify({status: 'done', claims: []}))
        }
        expect(await f.engine.advance('run', 'driver')).toMatchObject({
            kind: 'wait',
            reason: expect.stringContaining(`awaiting ${bad}`) as string,
        })
        await writeFile(reissued.staged[bad ?? ''] ?? '', JSON.stringify({status: 'done', claims: []}))
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'execute', attempt: {stage: 'docs'}})
        expect((await f.store.read('run')).rejections).toBeUndefined()
    })
    it('backs off on transient failures, resets the count after a clean call, and parks on the fifth in a row', async () => {
        const f = await setup('deliver')
        const run = await f.store.read('run')
        run.verified_feature = {head_sha: sha, spec_digest: run.spec_digest}
        await f.store.write(run)
        vi.mocked(f.runtime.reconcileBase).mockRejectedValue(new TransientFailure('git fetch failed: timeout'))
        // Canary #8: a ~5-minute GitHub push outage outlasted flat 60 s retries.
        for (const [k, seconds] of [60, 120, 240, 480].entries()) {
            expect(await f.engine.advance('run', 'driver')).toEqual({
                kind: 'wait',
                run_id: 'run',
                reason: `transient failure ${k + 1}/5: git fetch failed: timeout`,
                retry_after_seconds: seconds,
            })
            expect(await f.store.read('run')).toMatchObject({
                status: 'waiting',
                transient_failures: k + 1,
                stop_reason: {kind: 'environment'},
            })
        }
        vi.mocked(f.runtime.reconcileBase).mockResolvedValueOnce('unchanged')
        vi.mocked(f.runtime.deliver).mockResolvedValueOnce({kind: 'pending', number: 1, url: 'url', head: sha})
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'wait', retry_after_seconds: 60})
        expect((await f.store.read('run')).transient_failures).toBeUndefined()
        for (let k = 1; k <= 4; k++) {
            expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'wait'})
        }
        expect(await f.engine.advance('run', 'driver')).toMatchObject({
            kind: 'park',
            reason: 'git fetch failed: timeout',
        })
        const parked = await f.store.read('run')
        expect(parked.stop_reason?.kind).toBe('environment')
        expect(parked.attempts).toEqual({})
        expect((await f.engine.resume('run')).transient_failures).toBeUndefined()
        // A non-transient failure still parks at once.
        vi.mocked(f.runtime.reconcileBase).mockRejectedValue(new Error('feature PR was closed without merge'))
        expect(await f.engine.advance('run', 'driver')).toMatchObject({kind: 'park'})
    })
    it('refuses to create over a corrupt run that list() skips', async () => {
        const f = await setup()
        await mkdir(join(f.input.root, 'runs-v2', 'broken'), {recursive: true})
        await writeFile(join(f.input.root, 'runs-v2', 'broken', 'state.json'), '{')
        const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
        expect((await f.store.list()).map((run) => run.run_id)).toEqual(['run'])
        expect(warn.mock.calls.flat().join('')).toContain('skipping unreadable run broken')
        expect(await f.store.skipped()).toEqual(['broken'])
        await expect(f.engine.create({...f.input, runId: 'broken'})).rejects.toThrow('run broken already exists')
        expect(await readFile(join(f.input.root, 'runs-v2', 'broken', 'state.json'), 'utf8')).toBe('{')
        warn.mockRestore()
    })
    it('hands ownership to the session that drives the run and journals the change', async () => {
        const f = await setup()
        await f.engine.own('run', 'first')
        await f.engine.own('run', 'first')
        await f.engine.own('run', 'second')
        const run = await f.store.read('run')
        expect(run.owner_session).toBe('second')
        expect(run.audit.filter((row) => row.event === 'owner session changed').map((row) => row.details)).toEqual([
            {from: null, to: 'first'},
            {from: 'first', to: 'second'},
        ])
        await f.engine.resume('run', {cancel: true})
        await f.engine.own('run', 'third')
        expect((await f.store.read('run')).owner_session).toBe('second')
    })
})
