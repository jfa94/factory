import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
    resolveSpec,
    gateSpec,
    storeSpec,
    specCommand,
    resolveSpecRepo,
    specExitCode,
    type SpecBuildDeps,
} from './spec.js'
import {EXIT} from '../../shared/exit-codes.js'
import {parseArgs} from '../args.js'
import {FakeGitClient} from '../../git/index.js'
import {loadConfig} from '../../config/index.js'
import {stringifyJson} from '../../shared/json.js'
import {specBuildDir} from '../../core/state/paths.js'
import {SpecStore, buildManifest, SPEC_DEFAULTS, type GhClient, type Prd} from '../../spec/index.js'
import {at} from '../../shared/index.js'

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
        // Scratch root shares the test's own tmp dataDir (fine here — tests don't
        // need scratch/durable separated, just isolated per-test, which dataDir
        // already is). Production wires this to defaultSpecBuildRoot() instead.
        scratchRoot: dataDir,
    }
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
    dataDir = await mkdtemp(join(tmpdir(), 'spec-seam-'))
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
        expect(env.spawn.effort).toBe('max')
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

    it('Δ specExitCode: unspecifiable → EXIT.ERROR, every other envelope → EXIT.OK', async () => {
        const refused = await resolveSpec(depsWithBody(TRIVIAL_BODY), REPO, ISSUE)
        expect(specExitCode(refused)).toBe(EXIT.ERROR)

        const generate = await resolveSpec(deps(), 'owner/other', ISSUE)
        expect(specExitCode(generate)).toBe(EXIT.OK)
    })
})

describe('resolveSpec with regenerate:true (--supersede)', () => {
    it('deletes the existing spec and emits generate — never reuse', async () => {
        const store = new SpecStore({dataDir, docsRoot: join(dataDir, '_docs')})
        await store.write(buildManifest(REPO, ISSUE, PASS_GENERATED), PASS_GENERATED.specMd, PRD)

        const env = await resolveSpec(deps(), REPO, ISSUE, {regenerate: true})
        expect(env.kind).toBe('generate')
    })

    it('after deletion resolveByIssue returns null', async () => {
        const store = new SpecStore({dataDir, docsRoot: join(dataDir, '_docs')})
        await store.write(buildManifest(REPO, ISSUE, PASS_GENERATED), PASS_GENERATED.specMd, PRD)

        await resolveSpec(deps(), REPO, ISSUE, {regenerate: true})
        expect(await store.resolveByIssue(REPO, ISSUE)).toBeNull()
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

describe('specCommand (dispatch)', () => {
    it('prints help and returns OK for --help', async () => {
        expect(await specCommand.run(['--help'])).toBe(EXIT.OK)
    })
    it('returns USAGE for an unknown action', async () => {
        expect(await specCommand.run(['bogus'])).toBe(EXIT.USAGE)
    })
    it('returns USAGE when the required --issue is missing (--repo is optional/auto-derived)', async () => {
        // `--issue` is validated FIRST and short-circuits to USAGE before --repo is
        // ever resolved, so this exercises the missing-issue edge specifically.
        expect(await specCommand.run(['resolve'])).toBe(EXIT.USAGE)
    })
    it('returns USAGE for a non-positive --issue', async () => {
        expect(await specCommand.run(['gate', '--repo', REPO, '--issue', '0'])).toBe(EXIT.USAGE)
    })
})

// ---------------------------------------------------------------------------
// resolveSpecRepo — auto-derive --repo from the origin remote (Prompt G)
// ---------------------------------------------------------------------------

describe('resolveSpecRepo auto-derives --repo from the origin remote', () => {
    /** A FakeGitClient whose origin remote-url resolves to the given slug. */
    function gitWithOrigin(slug: string): FakeGitClient {
        const git = new FakeGitClient()
        git.setRemoteUrl('origin', `git@github.com:${slug}.git`)
        return git
    }

    /** Parse a spec argv tail (post-action) into the args resolveSpecRepo consumes. */
    function argsOf(...argv: string[]): ReturnType<typeof parseArgs> {
        return parseArgs(argv)
    }

    it('no --repo flag → derives the repo from origin', async () => {
        const repo = await resolveSpecRepo(argsOf('--issue', '123'), {
            gitClient: gitWithOrigin(REPO),
            cwd: '/wherever',
        })
        expect(repo).toBe(REPO)
    })

    it('an explicit --repo that MATCHES the origin (case-insensitively) wins as canonical', async () => {
        const repo = await resolveSpecRepo(argsOf('--repo', 'Owner/App', '--issue', '123'), {
            gitClient: gitWithOrigin(REPO),
            cwd: '/wherever',
        })
        expect(repo).toBe(REPO)
    })

    it('an explicit --repo that MISMATCHES the origin throws LOUD naming both', async () => {
        await expect(
            resolveSpecRepo(argsOf('--repo', 'owner/other', '--issue', '123'), {
                gitClient: gitWithOrigin(REPO),
                cwd: '/wherever',
            })
        ).rejects.toThrow(/owner\/other.*owner\/app|owner\/app.*owner\/other/s)
    })

    it('the mismatch is a UsageError (maps to EXIT.USAGE through the command wrapper)', async () => {
        await expect(
            resolveSpecRepo(argsOf('--repo', 'owner/other', '--issue', '123'), {
                gitClient: gitWithOrigin(REPO),
                cwd: '/wherever',
            })
        ).rejects.toMatchObject({isUsageError: true})
    })

    it('no --repo and no origin remote throws LOUD (cannot auto-derive)', async () => {
        await expect(
            resolveSpecRepo(argsOf('--issue', '123'), {
                gitClient: new FakeGitClient(), // no remotes configured
                cwd: '/wherever',
            })
        ).rejects.toThrow()
    })
})
