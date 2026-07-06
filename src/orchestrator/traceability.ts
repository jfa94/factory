/**
 * S9 (Decision 47) — the run-level PRD-TRACEABILITY stage.
 *
 * Runs between e2e and docs on a prospectively-completed run: one Opus auditor
 * judges the whole-PRD diff against the durable PRD snapshot's requirements and
 * returns one verdict per requirement. Any `unmet` verdict CONCLUDES the phase
 * `failed` — finalize overrides the run to `failed` and the rollup never fires.
 *
 * Mirrors docs.ts structurally, with two deliberate deltas:
 *   - crash cap → marker `failed` (docs is best-effort-done; traceability is the
 *     delivery gate — a run that could not be audited must not ship);
 *   - a `failed` action arm (a verdict is judgment, not a transient failure — no
 *     retry, the runner loops and next-task routes to finalize).
 *
 * A2: the pre-cap crash suspend writes NO quota checkpoint (`run.quota` present
 * ⇔ quota-caused stop); resume clears it unconditionally.
 */
import {join} from 'node:path'
import {z} from 'zod'
import {getOrThrow, nowIso} from '../shared/index.js'
import {parseProducerStatus} from './deps.js'
import {SpecStore, type Config, type GitClient, type SpecManifest, type StateManager} from './deps.js'
import {extractPrdRequirements} from '../spec/index.js'
import type {TraceabilityVerdictRow} from '../core/state/schema.js'

export interface TraceabilityRunDeps {
    readonly state: StateManager
    readonly git: GitClient
    readonly config: Config
    readonly dataDir: string
    /** The run's durable spec — the FULL criteria set, incl. any holdout criteria. */
    readonly spec: SpecManifest
}

export type TraceabilityAction =
    | {
          readonly kind: 'spawn'
          readonly run_id: string
          readonly worktree: string
          readonly base_ref: string
          readonly staging_branch: string
          readonly model: string
          readonly max_turns: number
          readonly prompt: string
      }
    | {readonly kind: 'done'; readonly run_id: string}
    | {readonly kind: 'failed'; readonly run_id: string; readonly reason: string}
    | {readonly kind: 'suspend'; readonly run_id: string; readonly reason: string}

const TRACE_MODEL = 'opus'
const TRACE_MAX_TURNS = 60

/**
 * Maximum crash attempts before the phase CONCLUDES `failed`. The anti-docs
 * delta: docs at cap degrades to best-effort-done, but traceability is the
 * delivery gate — an unauditable run finalizes `failed`, never ships.
 */
export const MAX_TRACE_ATTEMPTS = 2

/**
 * The traceability worktree path for a run. Lives under `worktrees/<runId>/`,
 * NOT `runs/<runId>/` — the TCB `data-runs` rule denies agent writes under
 * `runs/**` (the auditor is read-only, but Bash cwd bookkeeping still touches
 * the tree). The `.trace` dot prefix cannot collide with a task id.
 */
export function traceWorktreePath(dataDir: string, runId: string): string {
    return join(dataDir, 'worktrees', runId, '.trace')
}

/** Build the auditor prompt: PRD requirements as the axiom, diff as the evidence. @internal */
function buildAuditorPrompt(
    worktree: string,
    baseRef: string,
    requirements: readonly string[],
    spec: SpecManifest
): string {
    const reqLines = requirements.map((r, i) => `R${i + 1}. ${r}`)
    const criteriaLines = spec.tasks.flatMap((t) => [
        `[${t.task_id}] ${t.title}:`,
        ...t.acceptance_criteria.map((c) => `  - ${c}`),
    ])
    return [
        'You are the factory traceability auditor (agents/traceability-auditor.md).',
        `1. cd into your worktree: ${worktree} (detached checkout of the staging tip).`,
        `2. The whole-PRD change set is: git diff ${baseRef}..HEAD — judge ONLY that diff and the resulting tree.`,
        '3. The PRD requirements below are the AXIOM. For EACH one, hunt for credible evidence in the diff/tree that it is delivered AND exercised by tests.',
        '',
        'PRD requirements:',
        ...reqLines,
        '',
        'Spec acceptance criteria (context only — judge the requirements, not these):',
        ...criteriaLines,
        '',
        'Verdict rules: met = credible diff evidence, exercised by tests; partial = delivered incompletely or untested; unmet = no credible evidence in the diff/tree. Task statuses are NOT evidence.',
        'You are READ-ONLY: make NO commits, NO edits, NO pushes.',
        'Finish with your terminal STATUS line and return exactly {"status": "<line>", "verdicts": [{"index": <n>, "verdict": "met|partial|unmet", "evidence": "<cited evidence, ≤500 chars>"}, ...]} — one verdict per requirement R1..Rn, index matching the number above.',
    ].join('\n')
}

/** Read the durable PRD snapshot + extract its requirements — LOUD on zero. @internal */
async function readRequirements(deps: TraceabilityRunDeps, runId: string): Promise<string[]> {
    const run = await deps.state.read(runId)
    const prd = await new SpecStore({dataDir: deps.dataDir}).readPrd(run.spec.repo, run.spec.spec_id)
    const requirements = extractPrdRequirements(prd.body)
    if (requirements.length === 0) {
        throw new Error(
            `traceability: PRD #${prd.issue_number} snapshot yields no extractable requirements — ` +
                `nothing to audit (the specifiability gate should have refused this PRD)`
        )
    }
    return requirements
}

/** Emit the traceability spawn request: prepare the detached staging-tip worktree. */
export async function runTraceabilityEmit(deps: TraceabilityRunDeps, runId: string): Promise<TraceabilityAction> {
    const run = await deps.state.read(runId)
    const staging = run.staging_branch
    const base = deps.config.git.baseBranch
    const worktree = traceWorktreePath(deps.dataDir, runId)
    const baseRef = `origin/${base}`

    const requirements = await readRequirements(deps, runId)

    await deps.git.fetch('origin', staging)
    await deps.git.fetch('origin', base)
    // Idempotent on resume; --detach because the auditor never commits → no branch to GC.
    if (!(await deps.git.worktreeExists(worktree))) {
        await deps.git.worktreeAdd(['--detach', worktree, `origin/${staging}`])
    } else if ((run.traceability?.attempts ?? 0) >= 1) {
        // Retry after a crash: a read-only auditor should leave the tree clean, but a
        // died-mid-Bash attempt may not have — reset to the staging tip regardless.
        await deps.git.resetHardClean(`origin/${staging}`, {cwd: worktree})
    }

    return {
        kind: 'spawn',
        run_id: runId,
        worktree,
        base_ref: baseRef,
        staging_branch: staging,
        model: TRACE_MODEL,
        max_turns: TRACE_MAX_TURNS,
        prompt: buildAuditorPrompt(worktree, baseRef, requirements, deps.spec),
    }
}

export const TraceabilityResultsSchema = z
    .object({
        status: z.string().min(1),
        verdicts: z.array(
            z
                .object({
                    index: z.number().int().positive(),
                    verdict: z.enum(['met', 'partial', 'unmet']),
                    evidence: z.string().min(1).max(500),
                })
                .strict()
        ),
    })
    .strict()
export type TraceabilityResults = z.infer<typeof TraceabilityResultsSchema>

/**
 * Record an auditor result. DONE → semantic-coverage check (exactly one verdict
 * per requirement — Zod covers shape, this covers meaning), then conclude `done`
 * (no unmet; partial passes and surfaces in the report) or `failed` (any unmet —
 * no retry, a verdict is judgment). Not-done → crash accounting: suspend below
 * the cap (NO quota, A2), conclude `failed` at it.
 */
export async function runTraceabilityRecord(
    deps: TraceabilityRunDeps,
    runId: string,
    results: TraceabilityResults
): Promise<Extract<TraceabilityAction, {kind: 'done' | 'failed' | 'suspend'}>> {
    const run = await deps.state.read(runId)
    const worktree = traceWorktreePath(deps.dataDir, runId)
    const outcome = parseProducerStatus(results.status)

    if (outcome.status === 'done') {
        // Re-extract deterministically — same snapshot the emit prompt was built from.
        const requirements = await readRequirements(deps, runId)
        const byIndex = new Map(results.verdicts.map((v) => [v.index, v]))
        const covered =
            byIndex.size === results.verdicts.length &&
            byIndex.size === requirements.length &&
            requirements.every((_, i) => byIndex.has(i + 1))
        if (!covered) {
            throw new Error(
                `traceability: audit must carry exactly one verdict per requirement 1..${requirements.length}, ` +
                    `got indices [${results.verdicts.map((v) => v.index).join(', ')}]`
            )
        }
        // Persist requirement TEXT, not index — frozen against extractor drift.
        const rows: TraceabilityVerdictRow[] = requirements.map((requirement, i) => {
            const v = getOrThrow(byIndex, i + 1)
            return {requirement, verdict: v.verdict, evidence: v.evidence}
        })
        const unmet = rows.filter((r) => r.verdict === 'unmet')
        // Concluded either way — the worktree has no further use (no retry leg here).
        await deps.git.worktreeRemove([worktree, '--force'])

        if (unmet.length === 0) {
            await deps.state.update(runId, (s) => ({
                ...s,
                traceability: {status: 'done' as const, verdicts: rows, ended_at: nowIso()},
            }))
            return {kind: 'done', run_id: runId}
        }
        const reason = `PRD requirements unmet: ` + unmet.map((r) => `"${r.requirement}"`).join('; ')
        await deps.state.update(runId, (s) => ({
            ...s,
            traceability: {status: 'failed' as const, reason, verdicts: rows, ended_at: nowIso()},
        }))
        return {kind: 'failed', run_id: runId, reason}
    }

    // Crash leg: track attempts; conclude `failed` at the cap (anti-docs delta —
    // never best-effort), suspend for a retry below it.
    const reason = 'reason' in outcome ? outcome.reason : 'traceability phase failed'
    const attempts = (run.traceability?.attempts ?? 0) + 1
    const marker = {
        status: 'failed' as const,
        reason,
        attempts,
        verdicts: [],
        ended_at: nowIso(),
    }

    if (attempts >= MAX_TRACE_ATTEMPTS) {
        await deps.git.worktreeRemove([worktree, '--force'])
        await deps.state.update(runId, (s) => ({...s, traceability: marker}))
        return {kind: 'failed', run_id: runId, reason}
    }

    await deps.state.update(runId, (s) => ({
        ...s,
        status: 'suspended',
        traceability: marker,
    }))
    return {kind: 'suspend', run_id: runId, reason}
}
