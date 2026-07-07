/**
 * Shared test fixtures for the per-task orchestrator (orchestrator.test.ts) and the run-level
 * orchestrator (next.test.ts). Extracted verbatim from orchestrator.test.ts with one additive
 * extension: `runStatusOverride` seeds the run with a non-"running" status after
 * creation (needed for nextTask paused/terminal scenarios).
 *
 * Zero behavior change to the original fixture — all existing options behave
 * identically. New option is additive-only.
 */
import {mkdtemp, rm} from 'node:fs/promises'
import {epochToIso} from '../shared/time.js'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {defaultConfig} from '../config/schema.js'
import {parseSpecManifest} from '../spec/schema.js'
import type {Prd, SpecManifest} from '../spec/index.js'
import {StateManager} from '../core/state/manager.js'
import {FakeGitClient, FakeGhClient} from '../git/fakes.js'
import {contractedLoader, makeFakeTools, FakeGitProbe, commit} from '../verifier/deterministic/fakes.js'
import {InMemoryHoldoutStore} from '../verifier/holdout/index.js'
import {fakeUsageSignal, type UsageReading} from '../quota/usage-source.js'
import type {TaskState, RunStatus} from '../types/index.js'
import {isTerminalRunStatus} from '../core/state/schema.js'
import type {OrchestratorDeps} from './orchestrator.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const NOW = 1_700_000_000

export function reading(opts: {five: number; seven: number; fiveResets?: number; sevenResets?: number}): UsageReading {
    return {
        kind: 'available',
        fiveHour: {utilizationPct: opts.five, resetsAtEpoch: opts.fiveResets ?? NOW + 18_000},
        sevenDay: {utilizationPct: opts.seven, resetsAtEpoch: opts.sevenResets ?? NOW + 604_800},
        capturedAt: NOW,
    }
}

export const PROCEED = reading({five: 0, seven: 0})
export const PAUSE_5H = reading({five: 21, seven: 0}) // 5h breach

export function greenProbe(): FakeGitProbe {
    return new FakeGitProbe({
        // Only origin/staging-run-1 is needed: both handlers.verify and record.ts
        // applyRecordReviews now use runStagingBranch(runId) = "staging-run-1", so the
        // gate looks up origin/staging-run-1. The shared origin/staging seed was removed
        // after record.ts was fixed to use the per-run branch (Decision 33).
        refs: {'origin/staging-run-1': 'sha-base', HEAD: 'sha-head'},
        changedFiles: [],
        commits: [
            commit({sha: 'c1', files: ['src/x.test.ts'], tagged: true}),
            commit({sha: 'c2', files: ['src/x.ts'], tagged: true}),
        ],
    })
}

export function makeSpec(
    tasks: readonly {
        task_id: string
        acceptance_criteria?: readonly string[]
        tdd_exempt?: boolean
        depends_on?: readonly string[]
        risk_tier?: 'low' | 'medium' | 'high'
    }[]
): SpecManifest {
    return parseSpecManifest({
        spec_id: '42-checkout',
        issue_number: 42,
        slug: 'checkout',
        repo: 'acme/widgets',
        generated_at: '2026-06-01T00:00:00.000Z',
        tasks: tasks.map((t) => ({
            task_id: t.task_id,
            title: `task ${t.task_id}`,
            description: `does ${t.task_id}`,
            files: [`src/${t.task_id}.ts`],
            acceptance_criteria: t.acceptance_criteria ?? ['a', 'b', 'c'],
            tests_to_write: ['covers it'],
            depends_on: t.depends_on ?? [],
            risk_tier: t.risk_tier ?? 'medium',
            risk_rationale: 'moderate',
            ...(t.tdd_exempt === true ? {tdd_exempt: true} : {}),
        })),
    })
}

/** S9: a healthy PRD snapshot for `SpecStore.write`'s required third param. */
export function makePrd(over: Partial<Prd> = {}): Prd {
    return {
        issue_number: 42,
        title: 'Checkout Redesign',
        body: '## Requirements\n\n- checkout must work\n\n## Acceptance Criteria\n\n- returns 201',
        labels: ['prd'],
        body_truncated: false,
        ...over,
    }
}

// ---------------------------------------------------------------------------
// makeOrchestratorDeps
// ---------------------------------------------------------------------------

export interface MakeOrchestratorDepsOpts {
    /** Spec task overrides (default: one pending T1 with 3 acceptance criteria). */
    tasks?: readonly {
        task_id: string
        acceptance_criteria?: readonly string[]
        tdd_exempt?: boolean
        depends_on?: readonly string[]
        risk_tier?: 'low' | 'medium' | 'high'
    }[]
    /** Seed task STATE overrides (over and above defaults). */
    taskStateOverrides?: Partial<TaskState> & {task_id?: string}
    /** Usage reading (default: PROCEED). */
    usage?: UsageReading
    /** Ship mode (default: no-merge for test safety). */
    shipMode?: 'live' | 'no-merge'
    /** FakeGhClient factory (optional override for live-merge tests). */
    ghClient?: FakeGhClient
    /**
     * Override the run status after creation (additive — not present in original).
     * Useful for nextTask tests that need a paused/completed run at seed time.
     */
    runStatusOverride?: RunStatus
    /** Docs-applicability gate result (default false → existing all-terminal tests unaffected). */
    docsApplicable?: boolean
}

export interface OrchestratorDepsResult {
    deps: OrchestratorDeps
    runId: string
    dataDir: string
    state: StateManager
    holdout: InMemoryHoldoutStore
    cleanup: () => Promise<void>
}

export async function makeOrchestratorDeps(opts: MakeOrchestratorDepsOpts = {}): Promise<OrchestratorDepsResult> {
    const dataDir = await mkdtemp(join(tmpdir(), 'factory-orchestrator-'))
    const state = new StateManager({
        dataDir,
        lock: {stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50},
    })
    const holdout = new InMemoryHoldoutStore()
    const runId = 'run-1'

    // Default to single criterion so holdout is not seeded (avoids verdict-store
    // read errors in tests that don't provide holdout results).
    const taskDefs = opts.tasks ?? [{task_id: 'T1', acceptance_criteria: ['only one']}]

    const spec = makeSpec(taskDefs)

    await state.create({
        run_id: runId,
        staging_branch: `staging-${runId}`,
        spec: {repo: 'acme/widgets', spec_id: '42-checkout', issue_number: 42},
    })

    // Seed tasks — overrides apply only when task_id matches (or T1 by default)
    await state.update(runId, (s) => {
        const next = {...s.tasks}
        for (const tDef of taskDefs) {
            const override =
                opts.taskStateOverrides !== undefined && (opts.taskStateOverrides.task_id ?? 'T1') === tDef.task_id
                    ? opts.taskStateOverrides
                    : {}
            next[tDef.task_id] = {
                task_id: tDef.task_id,
                status: override.status ?? 'pending',
                depends_on: [...(tDef.depends_on ?? [])],
                escalation_rung: override.escalation_rung ?? 0,
                reviewers: override.reviewers ?? [],
                merge_resyncs: override.merge_resyncs ?? 0,
                ...(override.failure_class ? {failure_class: override.failure_class} : {}),
                ...(override.failure_reason != null && override.failure_reason.length > 0
                    ? {failure_reason: override.failure_reason}
                    : {}),
                ...(override.phase ? {phase: override.phase} : {}),
                ...(override.pr_number != null ? {pr_number: override.pr_number} : {}),
                ...(override.branch != null && override.branch.length > 0 ? {branch: override.branch} : {}),
            }
        }
        // Apply run status override if provided — terminal statuses require ended_at
        // (refineRunCrossFields invariant), so auto-stamp it here rather than at every call site.
        const statusPatch =
            opts.runStatusOverride !== undefined
                ? {
                      status: opts.runStatusOverride,
                      ...(isTerminalRunStatus(opts.runStatusOverride) ? {ended_at: epochToIso(NOW)} : {}),
                  }
                : {}
        return {...s, ...statusPatch, tasks: next}
    })

    const gh = opts.ghClient ?? new FakeGhClient()
    const git = new FakeGitClient({remoteHeads: {[`staging-${runId}`]: 'sha-staging'}})

    const deps: OrchestratorDeps = {
        config: defaultConfig(),
        spec,
        git,
        gh,
        tools: makeFakeTools({git: greenProbe()}),
        loadContract: contractedLoader({
            coverage: {contracted: false, reason: 'fixture: coverage not exercised'},
            sast: {contracted: false, reason: 'fixture: no security command'},
        }),
        holdout,
        dataDir,
        owner: 'acme',
        repo: 'widgets',
        shipMode: opts.shipMode ?? 'no-merge',
        state,
        usage: fakeUsageSignal(opts.usage ?? PROCEED),
        now: () => NOW,
        docsApplicable: () => Promise.resolve(opts.docsApplicable ?? false),
    }

    return {
        deps,
        runId,
        dataDir,
        state,
        holdout,
        cleanup: () => rm(dataDir, {recursive: true, force: true}),
    }
}
