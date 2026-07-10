/**
 * Spec-build cores (./build.ts), tested DIRECTLY — the resolveSpec / gateSpec /
 * storeSpec envelope contracts against a real SpecStore temp dir with a fake gh.
 * The `factory spec <verb>` CLI dispatch over these (usage edges, repo
 * auto-derive, exit-code mapping) lives in src/cli/subcommands/spec.test.ts.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {rm, mkdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {resolveSpec, gateSpec, storeSpec, buildManifest, type SpecBuildDeps} from './build.js'
import {SpecStore, SPEC_DEFAULTS, type GhClient, type Prd} from './index.js'
import {fakeUsageSignal, type UsageReading} from '../quota/index.js'
import {loadConfig} from '../config/index.js'
import {stringifyJson} from '../shared/json.js'
import {specBuildDir} from '../core/state/paths.js'
import {at} from '../shared/index.js'
import {makeTempDataDir} from '../cli/test-fixtures.js'

const REPO = 'owner/app'
const ISSUE = 123

/**
 * A HEALTHY PRD (S9: passes the specifiability gate — ≥200 chars of content,
 * extractable requirements, an AC-shaped section) whose every extractable
 * requirement is fully covered by the passing task's criterion.
 */
const PRD_BODY = [
    '## Summary',
    '',
    'Shoppers authenticate to the application with their email address and password. ' +
        'A successful login issues a session token the client stores and presents on ' +
        'subsequent requests to the application programming interface.',
    '',
    '## Requirements',
    '',
    '- Users must be able to log in with email and password and receive a session token',
    '',
    '## Acceptance Criteria',
    '',
    '- User logs in with valid email and password and receives a session token',
].join('\n')

/** A body the specifiability gate refuses on all three checks. */
const TRIVIAL_BODY = 'Make login better please.'

/** The durable PRD snapshot matching PRD_BODY (S9 — SpecStore.write's third param). */
const PRD: Prd = {
    issue_number: ISSUE,
    title: 'Login',
    body: PRD_BODY,
    labels: [],
    body_truncated: false,
}

const PASS_TASK = {
    task_id: 'T1',
    title: 'Email/password login',
    description: 'Implement email and password login issuing a session token',
    files: ['src/auth/login.ts'],
    acceptance_criteria: ['User logs in with valid email and password and receives a session token'],
    tests_to_write: ['Test login with valid email and password returns a session token'],
    depends_on: [] as string[],
    risk_tier: 'medium' as const,
    risk_rationale: 'auth is security-sensitive',
}

const PASS_GENERATED = {
    specMd: '# Login spec\n\nEmail/password login.',
    slug: 'email-login',
    tasks: [PASS_TASK],
}

/** A vague criterion trips the deterministic testability gate. */
const FAIL_GENERATED = {
    ...PASS_GENERATED,
    tasks: [{...PASS_TASK, acceptance_criteria: ['works well'], tests_to_write: ['smoke test']}],
}

const PASS_VERDICT = {
    decision: 'PASS',
    score: 60,
    per_dimension: {
        granularity: 10,
        dependencies: 10,
        acceptance_criteria: 10,
        tests: 10,
        vertical_slices: 10,
        alignment: 10,
    },
    blockers: [] as string[],
    concerns: [] as string[],
}

/** granularity 5 ≤ floor (5) → NEEDS_REVISION regardless of total. */
const FAIL_VERDICT = {
    decision: 'NEEDS_REVISION',
    score: 45,
    per_dimension: {
        granularity: 5,
        dependencies: 8,
        acceptance_criteria: 8,
        tests: 8,
        vertical_slices: 8,
        alignment: 8,
    },
    blockers: ['granularity too coarse'],
    concerns: [] as string[],
}

let dataDir: string

/** Frozen epoch SECONDS — the unit the quota pacer windows are computed in. */
const NOW = 1_700_000_000

/** Build a usage reading; both windows fresh + future-reset unless overridden. */
function usageReading(opts: {five: number; seven: number}): UsageReading {
    return {
        kind: 'available',
        fiveHour: {utilizationPct: opts.five, resetsAtEpoch: NOW + 18_000},
        sevenDay: {utilizationPct: opts.seven, resetsAtEpoch: NOW + 604_800},
        capturedAt: NOW,
    }
}

const USAGE_OK = usageReading({five: 0, seven: 0})
const USAGE_OVER_5H = usageReading({five: 21, seven: 0}) // hour-1 cap 20, 21 > 20 → pause
const USAGE_OVER_7D = usageReading({five: 0, seven: 21}) // day-1 cap 20, 21 > 20 → suspend
const USAGE_UNAVAILABLE: UsageReading = {kind: 'unavailable', reason: 'usage-cache-missing'}

/** A fake gh that returns the fixed PRD without spawning the real binary. */
const fakeGh: GhClient = {
    fetchPrd(issueNumber: number): Promise<Prd> {
        return Promise.resolve({
            issue_number: issueNumber,
            title: 'Login',
            body: PRD_BODY,
            labels: [],
            body_truncated: false,
        })
    },
}

function deps(): SpecBuildDeps {
    return {
        store: new SpecStore({dataDir, docsRoot: join(dataDir, '_docs')}),
        gh: fakeGh,
        config: loadConfig({dataDir}),
        usage: fakeUsageSignal(USAGE_OK),
        now: () => NOW,
        // Scratch root shares the test's own tmp dataDir (fine here — tests don't
        // need scratch/durable separated, just isolated per-test, which dataDir
        // already is). Production wires this to defaultSpecBuildRoot() instead.
        scratchRoot: dataDir,
    }
}

/** Deps whose usage signal returns a fixed (typically over-quota) reading. */
function depsWithUsage(reading: UsageReading): SpecBuildDeps {
    return {...deps(), usage: fakeUsageSignal(reading)}
}

/** Deps whose gh returns a custom PRD body (specifiability-gate tests). */
function depsWithBody(body: string): SpecBuildDeps {
    return {
        ...deps(),
        gh: {
            fetchPrd(issueNumber: number): Promise<Prd> {
                return Promise.resolve({
                    issue_number: issueNumber,
                    title: 'Login',
                    body,
                    labels: [],
                    body_truncated: false,
                })
            },
        },
    }
}

/** Write a scratch file into the (repo, issue) build dir. */
async function writeScratch(name: string, value: unknown): Promise<void> {
    const dir = specBuildDir(dataDir, REPO, ISSUE)
    await mkdir(dir, {recursive: true})
    await writeFile(join(dir, name), stringifyJson(value), 'utf8')
}

beforeEach(async () => {
    dataDir = await makeTempDataDir('spec-seam-')
})
afterEach(async () => {
    await rm(dataDir, {recursive: true, force: true})
})

describe('resolveSpec', () => {
    it('reuses an existing spec by issue number (Δ X — no generation)', async () => {
        const store = new SpecStore({dataDir, docsRoot: join(dataDir, '_docs')})
        await store.write(buildManifest(REPO, ISSUE, PASS_GENERATED), PASS_GENERATED.specMd, PRD)

        const env = await resolveSpec(deps(), REPO, ISSUE)
        expect(env.kind).toBe('reuse')
        if (env.kind !== 'reuse') {
            throw new Error('unreachable')
        }
        expect(env.pointer.issue_number).toBe(ISSUE)
        expect(env.pointer.spec_id).toBe(`${ISSUE}-email-login`)
    })

    it('emits the apex-pinned generate spawn + writes prd.json when no spec exists', async () => {
        const env = await resolveSpec(deps(), REPO, ISSUE)
        expect(env.kind).toBe('generate')
        if (env.kind !== 'generate') {
            throw new Error('unreachable')
        }

        expect(env.spawn.role).toBe('spec-generator')
        expect(env.spawn.model).toBe('opus')
        expect(env.spawn.effort).toBe('xhigh')
        expect(env.max_iterations).toBe(SPEC_DEFAULTS.maxRegenIterations)
        expect(env.generated_path.endsWith('generated.json')).toBe(true)

        // prd.json was persisted for the gate step to read.
        const {readFile} = await import('node:fs/promises')
        const prd = JSON.parse(await readFile(env.prd_path, 'utf8')) as Prd
        expect(prd.issue_number).toBe(ISSUE)
        expect(prd.body).toBe(PRD_BODY)
    })
})

describe('resolveSpec specifiability refusal (S9 — Δ pre-generation, zero agent cost)', () => {
    it('Δ an unspecifiable PRD emits the refusal envelope instead of generate', async () => {
        const env = await resolveSpec(depsWithBody(TRIVIAL_BODY), REPO, ISSUE)
        expect(env.kind).toBe('unspecifiable')
        if (env.kind !== 'unspecifiable') {
            throw new Error('unreachable')
        }

        expect(env.repo).toBe(REPO)
        expect(env.issue).toBe(ISSUE)
        expect(env.blockers.length).toBe(3)
        expect(env.blockers.every((b) => b.startsWith('specifiability:'))).toBe(true)
        // No spawn — the refusal is free.
        expect('spawn' in env).toBe(false)

        // prd.json was still written (inspection aid for the PRD author).
        const {readFile} = await import('node:fs/promises')
        const prd = JSON.parse(await readFile(env.prd_path, 'utf8')) as Prd
        expect(prd.body).toBe(TRIVIAL_BODY)
    })

    it('Δ the reuse path never runs the gate (an existing spec wins)', async () => {
        const store = new SpecStore({dataDir, docsRoot: join(dataDir, '_docs')})
        await store.write(buildManifest(REPO, ISSUE, PASS_GENERATED), PASS_GENERATED.specMd, PRD)

        const env = await resolveSpec(depsWithBody(TRIVIAL_BODY), REPO, ISSUE)
        expect(env.kind).toBe('reuse')
    })
})

describe('resolveSpec with regenerate:true (--supersede)', () => {
    it('skips the reuse check and emits generate — never reuse', async () => {
        const store = new SpecStore({dataDir, docsRoot: join(dataDir, '_docs')})
        await store.write(buildManifest(REPO, ISSUE, PASS_GENERATED), PASS_GENERATED.specMd, PRD)

        const env = await resolveSpec(deps(), REPO, ISSUE, {regenerate: true})
        expect(env.kind).toBe('generate')
    })

    it('the old durable spec SURVIVES resolve — replaced only when store persists the new one', async () => {
        // A mid-loop failure (crash, quota pause) must leave the old spec — and any
        // active run pointing at it — intact. Deletion happens at storeSpec time.
        const store = new SpecStore({dataDir, docsRoot: join(dataDir, '_docs')})
        await store.write(buildManifest(REPO, ISSUE, PASS_GENERATED), PASS_GENERATED.specMd, PRD)

        await resolveSpec(deps(), REPO, ISSUE, {regenerate: true})
        expect((await store.resolveByIssue(REPO, ISSUE))?.spec_id).toBe(`${ISSUE}-email-login`)
    })

    it('regenerate:false still reuses an existing spec', async () => {
        const store = new SpecStore({dataDir, docsRoot: join(dataDir, '_docs')})
        await store.write(buildManifest(REPO, ISSUE, PASS_GENERATED), PASS_GENERATED.specMd, PRD)

        const env = await resolveSpec(deps(), REPO, ISSUE, {regenerate: false})
        expect(env.kind).toBe('reuse')
    })

    it('regenerate:true with no existing spec is a no-op — still emits generate', async () => {
        const env = await resolveSpec(deps(), REPO, ISSUE, {regenerate: true})
        expect(env.kind).toBe('generate')
    })

    it('storeSpec replaces a different-slug old spec — no two-dirs integrity error', async () => {
        // Regen slug drift: the old spec is `123-email-login`, the regenerated one
        // comes back `123-login-rework`. Store must atomically-adjacently swap them.
        const store = new SpecStore({dataDir, docsRoot: join(dataDir, '_docs')})
        await store.write(buildManifest(REPO, ISSUE, PASS_GENERATED), PASS_GENERATED.specMd, PRD)

        await resolveSpec(deps(), REPO, ISSUE, {regenerate: true}) // writes scratch prd.json
        await writeScratch('generated.json', {...PASS_GENERATED, slug: 'login-rework'})
        await writeScratch('verdict.json', PASS_VERDICT)

        const env = await storeSpec(deps(), REPO, ISSUE)
        expect(env.kind).toBe('stored')
        if (env.kind !== 'stored') {
            throw new Error('unreachable')
        }
        expect(env.pointer.spec_id).toBe(`${ISSUE}-login-rework`)
        // Exactly one dir remains for the issue — the new one (resolveByIssue would
        // throw loud on two).
        expect((await store.resolveByIssue(REPO, ISSUE))?.spec_id).toBe(`${ISSUE}-login-rework`)
    })
})

describe('gateSpec', () => {
    it('emits revise(source=gate) when a deterministic gate blocks', async () => {
        await resolveSpec(deps(), REPO, ISSUE) // writes prd.json
        await writeScratch('generated.json', FAIL_GENERATED)

        const env = await gateSpec(deps(), REPO, ISSUE)
        expect(env.kind).toBe('revise')
        if (env.kind !== 'revise') {
            throw new Error('unreachable')
        }
        expect(env.source).toBe('gate')
        expect(env.blockers.length).toBeGreaterThan(0)

        // The revise envelope re-spawns the generator with the PRIOR spec + blockers
        // embedded, so the agent patches it instead of re-authoring from the PRD.
        expect(env.spawn.role).toBe('spec-generator')
        expect(env.spawn.model).toBe('opus')
        expect(env.spawn.context.prior_spec_md).toBe(FAIL_GENERATED.specMd)
        expect(env.spawn.context.prior_tasks).toEqual(FAIL_GENERATED.tasks)
        expect(env.spawn.context.review_feedback).toEqual(env.blockers)
    })

    it('emits the apex-pinned review spawn when gates pass', async () => {
        await resolveSpec(deps(), REPO, ISSUE) // writes prd.json
        await writeScratch('generated.json', PASS_GENERATED)

        const env = await gateSpec(deps(), REPO, ISSUE)
        expect(env.kind).toBe('review')
        if (env.kind !== 'review') {
            throw new Error('unreachable')
        }
        expect(env.spawn.role).toBe('spec-reviewer')
        expect(env.spawn.model).toBe('opus')
        expect(env.verdict_path.endsWith('verdict.json')).toBe(true)
    })

    it('fails LOUD on a legacy/invalid generated.json (untrusted agent boundary)', async () => {
        await resolveSpec(deps(), REPO, ISSUE)
        // A resurrected legacy classifier value must parse-fail, never silently coerce.
        await writeScratch('generated.json', {
            ...PASS_GENERATED,
            tasks: [{...PASS_TASK, risk_tier: 'routine'}],
        })
        await expect(gateSpec(deps(), REPO, ISSUE)).rejects.toThrow()
    })
})

describe('storeSpec', () => {
    it('emits revise(source=review) when the verdict trips the dimension floor', async () => {
        await resolveSpec(deps(), REPO, ISSUE) // writes prd.json (the revise spawn embeds the PRD)
        await writeScratch('generated.json', PASS_GENERATED)
        await writeScratch('verdict.json', FAIL_VERDICT)

        const env = await storeSpec(deps(), REPO, ISSUE)
        expect(env.kind).toBe('revise')
        if (env.kind !== 'revise') {
            throw new Error('unreachable')
        }
        expect(env.source).toBe('review')
        expect(env.reason).toMatch(/floor/)
        expect(env.blockers).toContain('granularity too coarse')

        // Same as the gate path: the prior spec + reviewer blockers ride along for a patch.
        expect(env.spawn.role).toBe('spec-generator')
        expect(env.spawn.context.prior_spec_md).toBe(PASS_GENERATED.specMd)
        expect(env.spawn.context.prior_tasks).toEqual(PASS_GENERATED.tasks)
        expect(env.spawn.context.review_feedback).toEqual(env.blockers)
    })

    it('throws LOUD when the revise path needs prd.json but resolve never wrote it', async () => {
        // This diff makes storeSpec's revise branch depend on prd.json for the FIRST time
        // (resolve writes it; the doc calls it durable across the loop). With no prd.json on
        // disk the read must fail attributably, not silently degrade the patch context.
        await writeScratch('generated.json', PASS_GENERATED)
        await writeScratch('verdict.json', FAIL_VERDICT) // NEEDS_REVISION → reads prd.json
        // NOTE: no resolveSpec(), so prd.json is absent.
        await expect(storeSpec(deps(), REPO, ISSUE)).rejects.toThrow(/prd\.json|ENOENT/)
    })

    it('synthesizes [decision.reason] into review_feedback when the reviewer lists no blockers', async () => {
        await resolveSpec(deps(), REPO, ISSUE) // writes prd.json
        await writeScratch('generated.json', PASS_GENERATED)
        // The dimension floor (granularity 5 ≤ 5) trips NEEDS_REVISION even with an empty
        // blockers array — exercising the `[decision.reason]` fallback the truthy-branch test misses.
        await writeScratch('verdict.json', {...FAIL_VERDICT, blockers: []})

        const env = await storeSpec(deps(), REPO, ISSUE)
        expect(env.kind).toBe('revise')
        if (env.kind !== 'revise') {
            throw new Error('unreachable')
        }
        expect(env.reason).toMatch(/floor/)
        // The fallback reason (not an empty array) is what rides into the patch spawn's feedback.
        expect(env.blockers).toEqual([env.reason])
        expect(env.spawn.context.review_feedback).toEqual(env.blockers)
    })

    it('persists the spec on PASS (incl. the durable PRD snapshot) and returns a reusable pointer', async () => {
        await resolveSpec(deps(), REPO, ISSUE) // writes scratch prd.json (S9: store snapshots it)
        await writeScratch('generated.json', PASS_GENERATED)
        await writeScratch('verdict.json', PASS_VERDICT)

        const env = await storeSpec(deps(), REPO, ISSUE)
        expect(env.kind).toBe('stored')
        if (env.kind !== 'stored') {
            throw new Error('unreachable')
        }
        expect(env.pointer.spec_id).toBe(`${ISSUE}-email-login`)

        // The durable spec is now readable + a subsequent resolve reuses it.
        const store = new SpecStore({dataDir, docsRoot: join(dataDir, '_docs')})
        const request = await store.read(REPO, env.pointer.spec_id)
        expect(request.tasks).toHaveLength(1)
        expect(at(request.tasks, 0).task_id).toBe('T1')

        // Δ S9: the PRD snapshot landed durably beside the spec.
        expect(await store.hasPrd(REPO, env.pointer.spec_id)).toBe(true)
        expect((await store.readPrd(REPO, env.pointer.spec_id)).body).toBe(PRD_BODY)

        const reResolve = await resolveSpec(deps(), REPO, ISSUE)
        expect(reResolve.kind).toBe('reuse')
    })

    it('fails LOUD on a verdict missing a rubric dimension', async () => {
        await writeScratch('generated.json', PASS_GENERATED)
        const {alignment, ...missingDim} = PASS_VERDICT.per_dimension
        void alignment
        await writeScratch('verdict.json', {...PASS_VERDICT, per_dimension: missingDim})
        await expect(storeSpec(deps(), REPO, ISSUE)).rejects.toThrow()
    })
})

// ---------------------------------------------------------------------------
// Entry quota gate (resolveSpec ONLY) — no apex spend STARTS over quota; the
// loop's continuation cost is bounded by attempts.json, never mid-loop gated.
// ---------------------------------------------------------------------------

describe('resolveSpec quota gate (entry-only)', () => {
    it('over the 7d curve on a fresh PRD → pause scope 7d with the reset horizon (no spawn)', async () => {
        const env = await resolveSpec(depsWithUsage(USAGE_OVER_7D), REPO, ISSUE)
        expect(env).toMatchObject({
            kind: 'pause',
            repo: REPO,
            issue: ISSUE,
            scope: '7d',
            resets_at_epoch: NOW + 604_800,
        })
        expect('spawn' in env).toBe(false)
    })

    it('over the 5h curve → pause scope 5h', async () => {
        const env = await resolveSpec(depsWithUsage(USAGE_OVER_5H), REPO, ISSUE)
        expect(env).toMatchObject({kind: 'pause', scope: '5h', resets_at_epoch: NOW + 18_000})
    })

    it('an unavailable usage reading fails CLOSED → pause scope unavailable, no reset horizon', async () => {
        const env = await resolveSpec(depsWithUsage(USAGE_UNAVAILABLE), REPO, ISSUE)
        expect(env.kind).toBe('pause')
        if (env.kind !== 'pause') {
            throw new Error('unreachable')
        }
        expect(env.scope).toBe('unavailable')
        expect(env.resets_at_epoch).toBeUndefined()
        expect(Object.keys(env).sort()).toEqual(['issue', 'kind', 'reason', 'repo', 'scope'])
    })

    it('an existing spec still REUSES over quota (reuse is free — never pauses)', async () => {
        const store = new SpecStore({dataDir, docsRoot: join(dataDir, '_docs')})
        await store.write(buildManifest(REPO, ISSUE, PASS_GENERATED), PASS_GENERATED.specMd, PRD)

        const env = await resolveSpec(depsWithUsage(USAGE_OVER_7D), REPO, ISSUE)
        expect(env.kind).toBe('reuse')
    })

    it('an unspecifiable PRD beats the pause (the author learns the PRD is broken even over quota)', async () => {
        const env = await resolveSpec(
            {...depsWithBody(TRIVIAL_BODY), usage: fakeUsageSignal(USAGE_OVER_7D)},
            REPO,
            ISSUE
        )
        expect(env.kind).toBe('unspecifiable')
    })

    it('ignoreQuota:true skips the gate entirely → generate', async () => {
        const env = await resolveSpec(depsWithUsage(USAGE_OVER_7D), REPO, ISSUE, {ignoreQuota: true})
        expect(env.kind).toBe('generate')
    })

    it('gate and store are NOT quota-gated (a mid-loop pause would waste the paid generator spawn)', async () => {
        await resolveSpec(deps(), REPO, ISSUE) // healthy entry
        await writeScratch('generated.json', PASS_GENERATED)
        expect((await gateSpec(depsWithUsage(USAGE_OVER_7D), REPO, ISSUE)).kind).toBe('review')

        await writeScratch('verdict.json', PASS_VERDICT)
        expect((await storeSpec(depsWithUsage(USAGE_OVER_7D), REPO, ISSUE)).kind).toBe('stored')
    })
})

// ---------------------------------------------------------------------------
// Engine-owned regen bound (attempts.json) — Model A: the ENGINE cuts the loop,
// the runner counts nothing.
// ---------------------------------------------------------------------------

describe('engine-owned regen bound (attempts.json)', () => {
    function depsWithMaxRegens(max: number): SpecBuildDeps {
        const base = deps()
        return {...base, config: {...base.config, spec: {...base.config.spec, maxRegenIterations: max}}}
    }

    async function readAttemptsFile(): Promise<unknown> {
        const {readFile} = await import('node:fs/promises')
        return JSON.parse(await readFile(join(specBuildDir(dataDir, REPO, ISSUE), 'attempts.json'), 'utf8'))
    }

    it('each revise increments the counter (gate source)', async () => {
        await resolveSpec(deps(), REPO, ISSUE)
        await writeScratch('generated.json', FAIL_GENERATED)

        expect((await gateSpec(deps(), REPO, ISSUE)).kind).toBe('revise')
        expect(await readAttemptsFile()).toEqual({iterations: 1})
        expect((await gateSpec(deps(), REPO, ISSUE)).kind).toBe('revise')
        expect(await readAttemptsFile()).toEqual({iterations: 2})
    })

    it('over maxRegenIterations → terminal spec-defect with iterations + blockers', async () => {
        const d = depsWithMaxRegens(1)
        await resolveSpec(d, REPO, ISSUE)
        await writeScratch('generated.json', FAIL_GENERATED)

        expect((await gateSpec(d, REPO, ISSUE)).kind).toBe('revise') // 1/1 consumed
        const env = await gateSpec(d, REPO, ISSUE) // would be regen #2 > 1
        expect(env.kind).toBe('spec-defect')
        if (env.kind !== 'spec-defect') {
            throw new Error('unreachable')
        }
        expect(env.source).toBe('gate')
        expect(env.iterations).toBe(1)
        expect(env.max_iterations).toBe(1)
        expect(env.blockers.length).toBeGreaterThan(0)
        // Terminal: no spawn rides along.
        expect('spawn' in env).toBe(false)
    })

    it('gate and review revises share ONE counter (bounds TOTAL regenerations)', async () => {
        const d = depsWithMaxRegens(2)
        await resolveSpec(d, REPO, ISSUE)

        await writeScratch('generated.json', FAIL_GENERATED)
        expect((await gateSpec(d, REPO, ISSUE)).kind).toBe('revise') // gate: 1/2

        await writeScratch('generated.json', PASS_GENERATED)
        await writeScratch('verdict.json', FAIL_VERDICT)
        expect((await storeSpec(d, REPO, ISSUE)).kind).toBe('revise') // review: 2/2

        const env = await storeSpec(d, REPO, ISSUE) // regen #3 > 2
        expect(env.kind).toBe('spec-defect')
        if (env.kind !== 'spec-defect') {
            throw new Error('unreachable')
        }
        expect(env.source).toBe('review')
        expect(env.iterations).toBe(2)
    })

    it('a fresh resolve emitting generate RESETS the counter', async () => {
        const d = depsWithMaxRegens(1)
        await resolveSpec(d, REPO, ISSUE)
        await writeScratch('generated.json', FAIL_GENERATED)
        expect((await gateSpec(d, REPO, ISSUE)).kind).toBe('revise') // 1/1 consumed

        // A new build loop for the same issue starts at zero.
        await resolveSpec(d, REPO, ISSUE)
        expect(await readAttemptsFile()).toEqual({iterations: 0})
        expect((await gateSpec(d, REPO, ISSUE)).kind).toBe('revise')
    })

    it('a missing attempts.json counts as 0 (scratch wipe already breaks the loop via generated.json)', async () => {
        await resolveSpec(deps(), REPO, ISSUE)
        await writeScratch('generated.json', FAIL_GENERATED)
        await rm(join(specBuildDir(dataDir, REPO, ISSUE), 'attempts.json'), {force: true})

        expect((await gateSpec(deps(), REPO, ISSUE)).kind).toBe('revise')
        expect(await readAttemptsFile()).toEqual({iterations: 1})
    })

    it('the spec-defect envelope carries EXACTLY {kind, repo, issue, source, iterations, max_iterations, reason, blockers}', async () => {
        const d = depsWithMaxRegens(0)
        await resolveSpec(d, REPO, ISSUE)
        await writeScratch('generated.json', FAIL_GENERATED)

        const env = await gateSpec(d, REPO, ISSUE)
        expect(env.kind).toBe('spec-defect')
        expect(Object.keys(env).sort()).toEqual([
            'blockers',
            'issue',
            'iterations',
            'kind',
            'max_iterations',
            'reason',
            'repo',
            'source',
        ])
    })
})

// ---------------------------------------------------------------------------
// Envelope exact shapes + durable round-trip (WS-D gap-fill)
// ---------------------------------------------------------------------------

describe('envelope exact shapes (runner contract)', () => {
    it('Δ the unspecifiable envelope carries EXACTLY {kind, repo, issue, prd_path, blockers}', async () => {
        const env = await resolveSpec(depsWithBody(TRIVIAL_BODY), REPO, ISSUE)
        expect(env.kind).toBe('unspecifiable')
        expect(Object.keys(env).sort()).toEqual(['blockers', 'issue', 'kind', 'prd_path', 'repo'])
    })

    it('the gate-failure revise envelope carries EXACTLY {kind, repo, issue, source, reason, blockers, spawn, generated_path}', async () => {
        await resolveSpec(deps(), REPO, ISSUE)
        await writeScratch('generated.json', FAIL_GENERATED)

        const env = await gateSpec(deps(), REPO, ISSUE)
        expect(env.kind).toBe('revise')
        expect(Object.keys(env).sort()).toEqual([
            'blockers',
            'generated_path',
            'issue',
            'kind',
            'reason',
            'repo',
            'source',
            'spawn',
        ])
    })

    it('the review-failure revise envelope has the SAME shape as the gate one (single revise contract)', async () => {
        await resolveSpec(deps(), REPO, ISSUE)
        await writeScratch('generated.json', PASS_GENERATED)
        await writeScratch('verdict.json', FAIL_VERDICT)

        const env = await storeSpec(deps(), REPO, ISSUE)
        expect(env.kind).toBe('revise')
        expect(Object.keys(env).sort()).toEqual([
            'blockers',
            'generated_path',
            'issue',
            'kind',
            'reason',
            'repo',
            'source',
            'spawn',
        ])
    })

    it('the stored spec is durable — the round-trip survives scratch-dir deletion (reads never touch scratch)', async () => {
        await resolveSpec(deps(), REPO, ISSUE) // seeds scratch prd.json via the resolve path
        await writeScratch('generated.json', PASS_GENERATED)
        await writeScratch('verdict.json', PASS_VERDICT)
        const env = await storeSpec(deps(), REPO, ISSUE)
        if (env.kind !== 'stored') {
            throw new Error('unreachable')
        }

        // Scratch is transient: nuke the whole build dir, then read everything back
        // from the durable store alone.
        await rm(specBuildDir(dataDir, REPO, ISSUE), {recursive: true, force: true})

        const store = new SpecStore({dataDir, docsRoot: join(dataDir, '_docs')})
        const request = await store.read(REPO, env.pointer.spec_id)
        expect(request.tasks).toHaveLength(1)
        expect(at(request.tasks, 0).task_id).toBe('T1')
        // Δ S9: the PRD snapshot is durable too — traceability reads it at finalize.
        expect((await store.readPrd(REPO, env.pointer.spec_id)).body).toBe(PRD_BODY)

        const reResolve = await resolveSpec(deps(), REPO, ISSUE)
        expect(reResolve.kind).toBe('reuse')
    })
})
