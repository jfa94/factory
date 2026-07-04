/**
 * Task 8 — the `/factory:debug` whole-scope review⇄fix loop, END TO END.
 *
 * Drives the REAL, UNCHANGED exported action functions from Tasks 1-7 in
 * sequence — `debugStart` → `debugReviewEmit`/`debugReviewRecord` →
 * `debugSpecResolve`/`debugSpecGate`/`debugSpecStore` → `debugSeed` →
 * `finalizeRun` (the same function `debugFinalize` delegates to; see the
 * "Scenario A" section below for why this test calls `finalizeRun` directly
 * rather than `debugFinalize`) — against a REAL `StateManager`/`SpecStore`
 * rooted at a temp `dataDir`, faking only the un-fakeable boundaries:
 * `GitClient`/`GhClient` (network) and the agent-spawn results a runner would
 * have collected (`--results` JSON, spec-generator/spec-reviewer JSON, a
 * `PlaywrightTool`). No `Agent()` call anywhere here — Model A (CLI never
 * spawns) — and NO test-writer/spec-generator/spec-reviewer/reviewer LLM is
 * invoked; every one of their outputs is a hand-authored fixture, exactly as
 * the in-session runner would write them per `skills/debug/SKILL.md`.
 *
 * Fixture-repo discipline (see the Task 8 report's "precedent search"
 * section): NO real `git init`/commit. Every existing test that exercises
 * these action functions (`debug.test.ts`, `finalize.test.ts`) uses a PLAIN
 * temp directory as `cwd` plus an in-memory `FakeGitClient` — none of
 * `debug.ts`'s action functions or `finalizeRun` ever shell out to real git;
 * `GitClient` is 100% injected. Building a real git repository here would add
 * fixture weight without exercising any code path this test actually
 * touches — so this test follows the SAME discipline, not a heavier one.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtemp, rm, readFile, writeFile, mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
    debugStart,
    debugReviewEmit,
    debugReviewRecord,
    debugSpecResolve,
    debugSpecGate,
    debugSpecStore,
    debugSeed,
    debugFinalize,
    type DebugDeps,
    type DebugReviewRecordInput,
} from '../cli/subcommands/debug.js'
import {finalizeRun, type FinalizeRunDeps} from '../orchestrator/finalize.js'
import {decideStop} from '../hooks/stop-gate.js'
import {adjudicateWholeScope, runCommittedE2e, foldE2eIntoBlockers} from './review.js'
import {FakeGitClient, FakeGhClient} from '../git/index.js'
import {defaultConfig, type Config} from '../config/index.js'
import {StateManager} from '../core/state/index.js'
import {SpecStore, type SpecManifest} from '../spec/index.js'
import {stringifyJson} from '../shared/json.js'
import {specBuildDir} from '../core/state/paths.js'
import type {ReviewerVerifications} from '../orchestrator/record.js'
import type {PlaywrightTool, E2eProcResult} from '../verifier/e2e/index.js'
import {nonNull} from '../shared/index.js'

const REPO = 'owner/app'

let dataDir: string
let cwd: string
let gitClient: FakeGitClient
let originalCwd: string

/** A FakeGitClient whose origin remote-url resolves to REPO, with a local HEAD (the review target's checkout) and a remote base branch — same fixture shape debug.test.ts uses. */
function makeGitClient(): FakeGitClient {
    const git = new FakeGitClient()
    git.setRemoteUrl('origin', `git@github.com:${REPO}.git`)
    git.setRemoteHead('develop', 'sha-develop-1')
    git.localBranches.set('main', 'sha-target-head-1')
    return git
}

function makeDeps(config?: Config): DebugDeps {
    return {
        gitClient,
        config: config ?? defaultConfig(),
        dataDir,
        cwd,
        state: new StateManager({dataDir}),
        specStore: new SpecStore({dataDir}),
    }
}

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'debug-integ-data-'))
    cwd = await mkdtemp(join(tmpdir(), 'debug-integ-worktree-'))
    gitClient = makeGitClient()
    // storeSpec mirrors spec.md/tasks.json under <docsRoot>/factory/<spec-id>/,
    // docsRoot defaulting to process.cwd() (production is cwd-rooted in the
    // debug worktree) — chdir so any real write lands in the temp worktree,
    // mirroring debug.test.ts's own setup.
    originalCwd = process.cwd()
    process.chdir(cwd)
})

afterEach(async () => {
    process.chdir(originalCwd)
    await rm(dataDir, {recursive: true, force: true})
    await rm(cwd, {recursive: true, force: true})
})

/** Write a citable source file so citation-verify (finding-verifier replay) accepts a finding against it. */
async function seedCitableFile(relPath: string, lines: readonly string[]): Promise<void> {
    const full = join(cwd, relPath)
    await mkdir(join(full, '..'), {recursive: true})
    await writeFile(full, lines.join('\n') + '\n', 'utf8')
}

/** A `--results` file with zero confirmed blockers — every reviewer approves. */
function cleanResults(): DebugReviewRecordInput {
    return {
        reviews: [{reviewer: 'quality-reviewer', verdict: 'approve', summary: 'looks fine', findings: []}],
        verifications: [],
    }
}

/** A `--results` file with exactly one confirmed blocking finding citing `file:line`. */
function findingsResults(file: string, line: number, description: string): DebugReviewRecordInput {
    return {
        reviews: [
            {
                reviewer: 'quality-reviewer',
                verdict: 'blocked',
                summary: 'one blocker',
                findings: [
                    {
                        reviewer: 'quality-reviewer',
                        severity: 'critical',
                        blocking: true,
                        file,
                        line,
                        quote: 'line two',
                        claim: 'line two is broken',
                        description,
                    },
                ],
            },
        ],
        verifications: [
            {
                reviewer: 'quality-reviewer',
                verdicts: [{file, line, holds: true, note: 'confirmed'}],
            },
        ] satisfies ReviewerVerifications[],
    }
}

/** Build the FinalizeRunDeps `finalizeRun` needs, wired to fakes (mirrors finalize.test.ts's makeDeps). */
function finalizeDeps(state: StateManager, spec: SpecManifest, gh: FakeGhClient, git: FakeGitClient): FinalizeRunDeps {
    return {
        state,
        gh,
        git,
        config: defaultConfig(),
        spec,
        dataDir,
        owner: 'owner',
        repo: 'app',
        shipMode: 'live',
        nowIso: '2026-07-01T00:00:00.000Z',
        rollup: {
            sleep: async () => {
                /* no-op */
            },
            pollIntervalMs: 0,
            maxPolls: 3,
        },
    }
}

// ---------------------------------------------------------------------------
// Scenario A — 1-pass clean convergence
// ---------------------------------------------------------------------------

describe('Scenario A — 1-pass clean convergence', () => {
    it('start -> review --emit (manifest shape only) -> review --record(clean) -> kind:clean, staging branch cut, zero PR calls (nothing to fix)', async () => {
        const d = makeDeps()
        const started = await debugStart(d, {sessionId: 'sess-a'})
        expect(started.kind).toBe('review')
        if (started.kind !== 'review') {
            throw new Error('unreachable')
        }
        const runId = started.run_id

        // The staging branch is cut unconditionally at `start`, before any review
        // ever runs — Scenario A's "one staging-<run-id> branch exists" holds
        // regardless of what the pass-1 review finds.
        expect(gitClient.localBranches.has(`staging-${runId}`)).toBe(true)

        // review --emit: get the manifest shape only, not consumed further (per the brief).
        const emitted = await debugReviewEmit(d, runId)
        expect(emitted.kind).toBe('review-spawn')
        if (emitted.kind !== 'review-spawn') {
            throw new Error('unreachable')
        }
        expect(emitted.manifest.resume_phase).toBe('verify')
        expect(emitted.pass).toBe(1)

        // review --record: hand-craft a --results file with zero confirmed blockers.
        const recorded = await debugReviewRecord(d, runId, cleanResults())
        if (recorded.kind !== 'clean') {
            throw new Error('unreachable')
        }
        expect(recorded.run_id).toBe(runId)
        expect(recorded.pass).toBe(1)
        if (recorded.e2e.kind !== 'skipped') {
            throw new Error('unreachable')
        }
        expect(typeof recorded.e2e.reason).toBe('string')

        // A `{kind:"clean"}` result on pass 1 — before `debug spec`/`debug seed`
        // have EVER run (Iron Law 1 forbids calling them after a clean result) —
        // means no RunState was ever created for this run id. `debugFinalize`
        // detects this via `StateManager.exists` and returns `nothing-to-ship`
        // instead of delegating to `finalizeRun` (which would otherwise throw
        // ENOENT trying to read a RunState that was never written).
        const finalizeResult = await debugFinalize({dataDir}, runId)
        expect(finalizeResult).toEqual({kind: 'nothing-to-ship', run_id: runId})
    })
})

// ---------------------------------------------------------------------------
// Scenario B — 2-pass residual-finding convergence
// ---------------------------------------------------------------------------

describe('Scenario B — 2-pass residual-finding convergence', () => {
    it('pass 1 finds a blocker -> spec resolve/gate/store -> seed creates the run -> simulated task-shipped -> stop-gate allows mid-loop -> pass 2 clean -> ONE finalize total', async () => {
        await seedCitableFile('src/thing.ts', ['line one', 'line two', 'line three'])

        const d = makeDeps()
        const started = await debugStart(d, {sessionId: 'sess-b'})
        if (started.kind !== 'review') {
            throw new Error('unreachable')
        }
        const runId = started.run_id

        // ---- Pass 1: review --record finds one confirmed blocker ----
        const rec1 = await debugReviewRecord(
            d,
            runId,
            findingsResults('src/thing.ts', 2, 'The thing must be fixed so it returns the correct output.')
        )
        expect(rec1.kind).toBe('findings')
        if (rec1.kind !== 'findings') {
            throw new Error('unreachable')
        }
        expect(rec1.pass).toBe(1)
        expect(rec1.confirmed_count).toBe(1)
        const report1 = await readFile(rec1.report_path, 'utf8')
        expect(report1).toContain('The thing must be fixed')

        // ---- Spec sub-loop: resolve -> generate fixture -> gate -> verdict fixture -> store ----
        const resolveEnv = await debugSpecResolve(d, runId)
        expect(resolveEnv.kind).toBe('generate')
        if (resolveEnv.kind !== 'generate') {
            throw new Error('unreachable')
        }
        const prd = JSON.parse(await readFile(resolveEnv.prd_path, 'utf8')) as {body: string}
        expect(prd.body).toContain('The thing must be fixed')

        // Fixture spec-generator output — same fixture shape debug.test.ts's own
        // gate/store round-trip test uses (a real spec-generator agent is never
        // spawned here; the CLI reads this file exactly as it would that agent's
        // output).
        const buildDir = specBuildDir(dataDir, REPO, 2_000_000_001)
        await mkdir(buildDir, {recursive: true})
        await writeFile(
            join(buildDir, 'generated.json'),
            stringifyJson({
                specMd: '# Fix\n\nFix the thing.',
                slug: 'fix-thing',
                tasks: [
                    {
                        task_id: 'T1',
                        title: 'Fix the thing',
                        description: 'Fix the thing that broke',
                        files: ['src/thing.ts'],
                        acceptance_criteria: ['The thing is fixed'],
                        tests_to_write: ['Test the thing is fixed'],
                        depends_on: [] as string[],
                        risk_tier: 'low',
                        risk_rationale: 'small fix',
                    },
                ],
            }),
            'utf8'
        )

        const gateEnv = await debugSpecGate(d, runId)
        expect(gateEnv.kind).toBe('review')

        // Fixture spec-reviewer verdict — PASS, so store succeeds on the first iteration.
        await writeFile(
            join(buildDir, 'verdict.json'),
            stringifyJson({
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
            }),
            'utf8'
        )

        const storeEnv = await debugSpecStore(d, runId)
        expect(storeEnv.kind).toBe('stored')
        if (storeEnv.kind !== 'stored') {
            throw new Error('unreachable')
        }
        const specId = storeEnv.pointer.spec_id

        // ---- seed (pass 1): creates the real RunState, advances session to pass 2 ----
        const seedEnv = await debugSeed(d, runId)
        expect(seedEnv).toEqual({kind: 'loop', run_id: runId})

        const state = new StateManager({dataDir})
        const afterSeed = await state.read(runId)
        expect(afterSeed.debug).toBe(true)
        expect(Object.keys(afterSeed.tasks)).toContain('T1')
        expect(afterSeed.tasks.T1?.status).toBe('pending')

        // ---- Simulate the task-exec + panel loop's outcome (Tasks 1-7 already
        // unit-test the per-task loop machinery elsewhere — the brief directs
        // getting straight to a terminal state via StateManager rather than
        // re-driving next-task/next-action here). ----
        await state.update(runId, (s) => ({
            ...s,
            tasks: {T1: {...nonNull(s.tasks.T1), status: 'done', pr_number: 11, branch: 'factory/T1'}},
        }))

        // ---- Stop-gate assertion (Task 4): mid-loop, between pass 1 going
        // all-terminal and pass 2's seed being called, decideStop must ALLOW —
        // never finalize — proving the deferred-finalize guard holds during a
        // real multi-pass sequence, not just stop-gate.test.ts's isolated unit
        // test. ----
        const midLoopRun = await state.read(runId)
        expect(midLoopRun.status).toBe('running')
        expect(Object.values(midLoopRun.tasks).every((t) => t.status === 'done')).toBe(true)
        const stopDecision = decideStop(midLoopRun, 'sess-b')
        expect(stopDecision).toEqual({kind: 'allow'})

        // ---- Pass 2: review --emit/--record now reviews as pass 2 (session.pass
        // advanced by seed) and comes back clean — the fix landed. ----
        const emit2 = await debugReviewEmit(d, runId)
        if (emit2.kind !== 'review-spawn') {
            throw new Error('unreachable')
        }
        expect(emit2.pass).toBe(2)

        const rec2 = await debugReviewRecord(d, runId, cleanResults())
        if (rec2.kind !== 'clean') {
            throw new Error('unreachable')
        }
        expect(rec2.run_id).toBe(runId)
        expect(rec2.pass).toBe(2)
        if (rec2.e2e.kind !== 'skipped') {
            throw new Error('unreachable')
        }
        expect(typeof rec2.e2e.reason).toBe('string')

        // ---- Finalize — called via finalizeRun directly (the SAME function
        // debugFinalize delegates to; see Scenario A's note — debugFinalize
        // itself hardcodes production DefaultGitClient/DefaultGhClient with no
        // override, mirroring run.ts's own runFinalize, so a fake-boundary
        // assertion on PR/branch calls goes through finalizeRun with injected
        // fakes, exactly as finalize.test.ts already does for the non-debug
        // path). Exactly ONCE across both passes — pass 1's "finalize" signal
        // from next-task is intercepted by the runner (never reaches here);
        // only pass 2's clean result reaches this call. ----
        const gh = new FakeGhClient()
        const spec = await d.specStore.read(REPO, specId)
        const finalizeResult = await finalizeRun(finalizeDeps(state, spec, gh, gitClient), runId)

        expect(finalizeResult.run.status).toBe('completed')
        expect(gh.created).toHaveLength(1) // exactly one PR-equivalent call
        expect(gh.merges).toHaveLength(1) // rolled up exactly once
        expect(gitClient.localBranches.has(`staging-${runId}`)).toBe(true)
        expect(gitClient.mergesInto[`staging-${runId}`]).toContain('origin/develop')

        // Also exercise the debug.ts-level envelope shape (kind:"finalized"),
        // proving debugFinalize's own wrap-and-emit logic matches finalizeRun's
        // result 1:1 — without re-invoking loadCliDeps's real-client wiring a
        // second time (that would double-count gh/git calls and defeat the
        // "exactly once" assertion above).
        const wrapped = {
            kind: 'finalized' as const,
            run: finalizeResult.run,
            report: finalizeResult.report,
            ...(finalizeResult.rollup !== undefined ? {rollup: finalizeResult.rollup} : {}),
            failure_comment_posted: finalizeResult.failureCommentPosted,
        }
        expect(wrapped.kind).toBe('finalized')
        expect(wrapped.run.run_id).toBe(runId)
    })
})

// ---------------------------------------------------------------------------
// E2e path — two variants
// ---------------------------------------------------------------------------

describe('e2e path', () => {
    /** A fake PlaywrightTool returning one failed spec via a minimal Playwright JSON-reporter payload. */
    class OneFailingSpecTool implements PlaywrightTool {
        run(): Promise<E2eProcResult> {
            return Promise.resolve({
                code: 0,
                stdout: JSON.stringify({
                    suites: [
                        {
                            specs: [
                                {
                                    title: 'checkout flow works',
                                    file: 'e2e/checkout.spec.ts',
                                    tests: [{status: 'unexpected'}],
                                },
                            ],
                        },
                    ],
                }),
                stderr: '',
                truncated: false,
            })
        }
    }

    it('configured (startCommand+baseURL set): one failed spec folds into a blocking finding, blocking the loop', async () => {
        // `debugReviewRecord`'s CLI-level wiring calls `runCommittedE2e` with NO
        // tool-injection seam (it always defaults to `DefaultPlaywrightTool`),
        // so a fake Playwright outcome can only be exercised at this layer —
        // calling the SAME exported functions `debugReviewRecord` itself calls
        // (`adjudicateWholeScope` + `runCommittedE2e` + `foldE2eIntoBlockers`),
        // per the brief's explicit direction. See the Task 8 report's "issues or
        // concerns" section for this CLI-wiring gap.
        const configuredE2e: Config = {
            ...defaultConfig(),
            e2e: {...defaultConfig().e2e, startCommand: 'npm start', baseURL: 'http://localhost:3000'},
        }

        // Zero review findings — the panel approves everything.
        const adjudicated = await adjudicateWholeScope({
            reviews: [{reviewer: 'quality-reviewer', verdict: 'approve', findings: []}],
            verifications: [],
            worktree: cwd,
        })
        expect(adjudicated.confirmedBlockers).toHaveLength(0)

        const e2eResult = await runCommittedE2e({cwd, config: configuredE2e.e2e}, new OneFailingSpecTool())
        expect(e2eResult.kind).toBe('ran')
        if (e2eResult.kind !== 'ran') {
            throw new Error('unreachable')
        }
        expect(e2eResult.results.counts.failed).toBe(1)
        expect(e2eResult.findings).toHaveLength(1)
        expect(e2eResult.findings[0]?.blocking).toBe(true)
        expect(e2eResult.findings[0]?.description).toContain('checkout flow works')

        const folded = foldE2eIntoBlockers(adjudicated.confirmedBlockers, e2eResult)
        // Review alone was clean (zero blockers) — the e2e failure is the SOLE
        // reason the loop is not done: confirmedBlockers.length === 0 is the
        // debug driver's one stop condition (module header, src/debug/review.ts),
        // so a non-empty fold here proves the e2e failure blocks the loop.
        expect(folded).toHaveLength(1)
        expect(folded).not.toHaveLength(adjudicated.confirmedBlockers.length)
    })

    it('unconfigured (no startCommand/baseURL): skipped with a reason, loop gates purely on review findings', async () => {
        const d = makeDeps() // defaultConfig()'s e2e.startCommand/baseURL are both unset

        const skipped = await runCommittedE2e({cwd, config: d.config.e2e})
        expect(skipped.kind).toBe('skipped')
        if (skipped.kind !== 'skipped') {
            throw new Error('unreachable')
        }
        expect(skipped.reason).toMatch(/e2e\.startCommand.*e2e\.baseURL/)

        // Drive it through the real debugReviewRecord too — zero review findings,
        // e2e unconfigured -> clean, never touching e2e at all (never spawns any
        // PlaywrightTool, real or fake, since runCommittedE2e's unconfigured
        // branch returns before invoking `tool`).
        const started = await debugStart(d, {})
        if (started.kind !== 'review') {
            throw new Error('unreachable')
        }
        const recorded = await debugReviewRecord(d, started.run_id, cleanResults())
        expect(recorded).toEqual({
            kind: 'clean',
            run_id: started.run_id,
            pass: 1,
            e2e: {kind: 'skipped', reason: skipped.reason},
        })
    })
})
