import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {StateManager} from '../core/state/manager.js'
import {specDir} from '../core/state/paths.js'
import {defaultConfig} from '../config/schema.js'
import {FakeGitClient} from '../git/fakes.js'
import {SpecStore} from '../spec/index.js'
import {makeSpec, makePrd} from './orchestrator-fixtures.js'
import {
    runTraceabilityEmit,
    runTraceabilityRecord,
    traceWorktreePath,
    MAX_TRACE_ATTEMPTS,
    TraceabilityResultsSchema,
    type TraceabilityRunDeps,
} from './traceability.js'

const RUN_ID = 'run-1'
const REPO = 'acme/widgets'
const SPEC_ID = '42-checkout'

// makePrd's default body extracts exactly two requirements:
// R1 "checkout must work", R2 "returns 201".
const PRD = makePrd()
// The second criterion plays the designated-holdout role: the auditor prompt must
// carry the FULL criteria set (engine-side read — the leak guard only denies agent
// reads of runs/**/holdouts/**), so it must appear verbatim.
const SPEC = makeSpec([
    {
        task_id: 'T1',
        acceptance_criteria: ['returns 201 on success', 'holdout: rejects a duplicate key'],
    },
])

let dataDir: string
let state: StateManager
let git: FakeGitClient

function deps(): TraceabilityRunDeps {
    return {state, git, config: defaultConfig(), dataDir, spec: SPEC}
}

const MET = {index: 1, verdict: 'met' as const, evidence: 'src/checkout.ts:12 handles it'}
const MET2 = {index: 2, verdict: 'met' as const, evidence: 'returns 201 in handler.ts:9'}

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'trace-'))
    state = new StateManager({dataDir})
    git = new FakeGitClient({remoteHeads: {[`staging-${RUN_ID}`]: 'sha-staging'}})
    await state.create({
        run_id: RUN_ID,
        staging_branch: `staging-${RUN_ID}`,
        spec: {repo: REPO, spec_id: SPEC_ID, issue_number: 42},
    })
    // Durable spec + PRD snapshot — what emit/record read (docsRoot kept off the cwd).
    await new SpecStore({dataDir, docsRoot: join(dataDir, 'docs-mirror')}).write(SPEC, '# spec', PRD)
})
afterEach(async () => {
    await rm(dataDir, {recursive: true, force: true})
})

describe('runTraceabilityEmit', () => {
    it('creates a DETACHED worktree at the staging tip and returns a spawn envelope', async () => {
        const env = await runTraceabilityEmit(deps(), RUN_ID)
        expect(env.kind).toBe('spawn')
        if (env.kind !== 'spawn') {
            throw new Error('expected spawn')
        }
        expect(env.staging_branch).toBe(`staging-${RUN_ID}`)
        expect(env.base_ref).toBe('origin/develop')
        expect(env.model).toBe('sonnet')
        expect(env.worktree).toBe(traceWorktreePath(dataDir, RUN_ID))
        // TCB: worktrees/<runId>/, never runs/** (agent writes there are denied).
        expect(env.worktree).toContain(join('worktrees', RUN_ID))
        // Detached — the auditor never commits, so there is no branch to GC.
        expect(git.calls.some((c) => c.startsWith('worktree add') && c.includes('--detach'))).toBe(true)
        expect(git.calls.some((c) => c.includes('-b '))).toBe(false)
    })

    it('prompt embeds numbered PRD requirements, FULL criteria (incl. holdout), diff + no-commit rules', async () => {
        const env = await runTraceabilityEmit(deps(), RUN_ID)
        if (env.kind !== 'spawn') {
            throw new Error('expected spawn')
        }
        expect(env.prompt).toContain('R1. checkout must work')
        expect(env.prompt).toContain('R2. returns 201')
        expect(env.prompt).toContain('[T1] task T1')
        expect(env.prompt).toContain('holdout: rejects a duplicate key')
        expect(env.prompt).toContain('git diff origin/develop..HEAD')
        expect(env.prompt).toMatch(/NO commits/i)
        expect(env.prompt).toContain(env.worktree)
    })

    it('is idempotent when the worktree already exists (resume): no second worktree add', async () => {
        await runTraceabilityEmit(deps(), RUN_ID)
        const callsAfterFirst = git.calls.length
        const second = await runTraceabilityEmit(deps(), RUN_ID)
        expect(second.kind).toBe('spawn')
        const adds = git.calls.slice(callsAfterFirst).filter((c) => c.startsWith('worktree add'))
        expect(adds).toHaveLength(0)
    })

    it('throws LOUD when the PRD snapshot is missing (older-factory spec, --supersede remedy)', async () => {
        await rm(join(dataDir, 'specs'), {recursive: true, force: true})
        await expect(runTraceabilityEmit(deps(), RUN_ID)).rejects.toThrow(/has no PRD snapshot.*--supersede/s)
    })

    it('throws LOUD when the PRD yields zero extractable requirements', async () => {
        await writeFile(
            join(specDir(dataDir, REPO, SPEC_ID), 'prd.json'),
            JSON.stringify(makePrd({body: 'just prose with no bullets and nothing normative'}))
        )
        await expect(runTraceabilityEmit(deps(), RUN_ID)).rejects.toThrow(/no.*requirements/i)
    })
})

describe('runTraceabilityRecord', () => {
    it('DONE + all met → marker done with requirement-TEXT verdicts, worktree removed', async () => {
        await runTraceabilityEmit(deps(), RUN_ID)
        const env = await runTraceabilityRecord(deps(), RUN_ID, {
            status: 'STATUS: DONE',
            verdicts: [MET, MET2],
        })
        expect(env.kind).toBe('done')
        const run = await state.read(RUN_ID)
        expect(run.traceability?.status).toBe('done')
        // Requirement TEXT, not index — frozen against extractor drift.
        expect(run.traceability?.verdicts).toEqual([
            {requirement: 'checkout must work', verdict: 'met', evidence: MET.evidence},
            {requirement: 'returns 201', verdict: 'met', evidence: MET2.evidence},
        ])
        expect(run.traceability?.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
        expect(run.status).not.toBe('suspended')
        expect(git.calls.some((c) => c.startsWith('worktree remove'))).toBe(true)
    })

    it('DONE + partial only → marker done (partial passes; surfaces as a gap, not a block)', async () => {
        await runTraceabilityEmit(deps(), RUN_ID)
        const env = await runTraceabilityRecord(deps(), RUN_ID, {
            status: 'STATUS: DONE',
            verdicts: [MET, {index: 2, verdict: 'partial', evidence: 'only the happy path'}],
        })
        expect(env.kind).toBe('done')
        const run = await state.read(RUN_ID)
        expect(run.traceability?.status).toBe('done')
        expect(run.traceability?.verdicts[1]?.verdict).toBe('partial')
    })

    it('DONE + any unmet → CONCLUDED failed: reason names the requirement, verdicts persisted, NO suspend, NO retry', async () => {
        await runTraceabilityEmit(deps(), RUN_ID)
        const env = await runTraceabilityRecord(deps(), RUN_ID, {
            status: 'STATUS: DONE',
            verdicts: [MET, {index: 2, verdict: 'unmet', evidence: 'no 201 anywhere in the diff'}],
        })
        expect(env.kind).toBe('failed')
        if (env.kind !== 'failed') {
            throw new Error('expected failed')
        }
        expect(env.reason).toContain('returns 201')
        const run = await state.read(RUN_ID)
        expect(run.traceability?.status).toBe('failed')
        expect(run.traceability?.reason).toContain('returns 201')
        expect(run.traceability?.verdicts).toHaveLength(2)
        // A verdict is judgment, not a transient failure — no crash attempts recorded.
        expect(run.traceability?.attempts).toBeUndefined()
        // Concluded, not suspended: the runner loops and next-task routes to finalize.
        expect(run.status).not.toBe('suspended')
        expect(run.quota).toBeUndefined()
    })

    it('DONE + missing index → throws LOUD (semantic coverage: one verdict per requirement)', async () => {
        await runTraceabilityEmit(deps(), RUN_ID)
        await expect(runTraceabilityRecord(deps(), RUN_ID, {status: 'STATUS: DONE', verdicts: [MET]})).rejects.toThrow(
            /exactly one verdict/i
        )
    })

    it('DONE + duplicate index → throws LOUD', async () => {
        await runTraceabilityEmit(deps(), RUN_ID)
        await expect(
            runTraceabilityRecord(deps(), RUN_ID, {
                status: 'STATUS: DONE',
                verdicts: [MET, {...MET2, index: 1}],
            })
        ).rejects.toThrow(/exactly one verdict/i)
    })

    it('DONE + out-of-range index → throws LOUD', async () => {
        await runTraceabilityEmit(deps(), RUN_ID)
        await expect(
            runTraceabilityRecord(deps(), RUN_ID, {
                status: 'STATUS: DONE',
                verdicts: [MET, MET2, {index: 3, verdict: 'met', evidence: 'phantom'}],
            })
        ).rejects.toThrow(/exactly one verdict/i)
    })

    it('crash below cap → suspends with attempts:1 and NO quota checkpoint (A2)', async () => {
        await runTraceabilityEmit(deps(), RUN_ID)
        const env = await runTraceabilityRecord(deps(), RUN_ID, {
            status: 'STATUS: BLOCKED — auditor died',
            verdicts: [],
        })
        expect(env.kind).toBe('suspend')
        if (env.kind !== 'suspend') {
            throw new Error('expected suspend')
        }
        expect(env.reason).toContain('BLOCKED')
        const run = await state.read(RUN_ID)
        expect(run.status).toBe('suspended')
        // A2: a non-quota suspend NEVER writes a quota checkpoint.
        expect(run.quota).toBeUndefined()
        expect(run.traceability?.status).toBe('failed')
        expect(run.traceability?.attempts).toBe(1)
        expect(run.traceability?.verdicts).toEqual([])
    })

    it('crash at cap → CONCLUDED failed (the anti-docs delta: never best-effort-done)', async () => {
        await runTraceabilityEmit(deps(), RUN_ID)
        await runTraceabilityRecord(deps(), RUN_ID, {status: 'STATUS: ERROR', verdicts: []})
        await state.update(RUN_ID, (s) => ({...s, status: 'running' as const}))
        const env = await runTraceabilityRecord(deps(), RUN_ID, {
            status: 'STATUS: ERROR again',
            verdicts: [],
        })
        expect(env.kind).toBe('failed')
        const run = await state.read(RUN_ID)
        expect(run.status).not.toBe('suspended')
        expect(run.traceability?.status).toBe('failed')
        expect(run.traceability?.attempts).toBe(MAX_TRACE_ATTEMPTS)
        expect(run.traceability?.verdicts).toEqual([])
    })
})

describe('TraceabilityResultsSchema', () => {
    it('rejects extra keys, empty evidence, and >500-char evidence', () => {
        expect(() => TraceabilityResultsSchema.parse({status: 'x', verdicts: [], extra: 1})).toThrow()
        expect(() =>
            TraceabilityResultsSchema.parse({
                status: 'x',
                verdicts: [{index: 1, verdict: 'met', evidence: ''}],
            })
        ).toThrow()
        expect(() =>
            TraceabilityResultsSchema.parse({
                status: 'x',
                verdicts: [{index: 1, verdict: 'met', evidence: 'e'.repeat(501)}],
            })
        ).toThrow()
        expect(
            TraceabilityResultsSchema.parse({
                status: 'STATUS: DONE',
                verdicts: [{index: 1, verdict: 'unmet', evidence: 'none found'}],
            }).verdicts
        ).toHaveLength(1)
    })
})
