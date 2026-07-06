import {join} from 'node:path'
import {ensureStageWorktree, publishToStaging} from './stage-helpers.js'
import type {StageDone, StageSpawnBase, StageSuspend} from './stage-helpers.js'
import {z} from 'zod'
import {nowIso} from '../shared/index.js'
import {parseProducerStatus, AGENT_TYPE_BY_ROLE} from './deps.js'
import {type Config, type GitClient, type StateManager} from './deps.js'

export interface DocsRunDeps {
    readonly state: StateManager
    readonly git: GitClient
    readonly config: Config
    readonly dataDir: string
}

export type DocsAction =
    | (StageSpawnBase & {
          readonly kind: 'spawn'
          readonly base_ref: string
          readonly docs_branch: string
      })
    | StageDone
    | StageSuspend

const DOCS_MODEL = 'opus'
const DOCS_MAX_TURNS = 60

/**
 * Maximum docs-phase attempts before the run treats docs as best-effort and finalizes
 * `completed` without a docs commit. Prevents an infinite suspend-loop when the scribe
 * agent repeatedly fails (e.g. a broken /docs path or a persistent git error).
 */
// ponytail: 2 is enough; a third retry rarely fixes a structural failure
export const MAX_DOCS_ATTEMPTS = 2

/**
 * The docs-phase worktree path for a run. Lives under `worktrees/<runId>/`, NOT
 * `runs/<runId>/` — the TCB `data-runs` rule denies agent writes under `runs/**`,
 * and the scribe must write here. The `.docs` dot prefix cannot collide with a
 * task id (`validateId` allows only `[a-zA-Z0-9_-]`).
 */
export function docsWorktreePath(dataDir: string, runId: string): string {
    return join(dataDir, 'worktrees', runId, '.docs')
}

/** Build the scribe prompt for the docs phase. @internal */
function buildScribePrompt(worktree: string, baseRef: string): string {
    return [
        "You are the factory scribe running the pipeline's documentation phase.",
        `1. cd into your worktree: ${worktree} (already checked out on the docs branch off the staging tip).`,
        `2. Determine the whole-PRD change set with: git diff ${baseRef}..HEAD`,
        '3. Update /docs (Diátaxis) to reflect those changes, per agents/scribe.md.',
        '4. COMMIT your changes IN this worktree. Do NOT push (the engine pushes on record).',
        '5. If nothing material changed, make no commit.',
        'Finish with your terminal STATUS line and return it as {"status": "<line>"}.',
    ].join('\n')
}

/** Emit the docs spawn request: prepare the staging-rooted worktree, name scribe. */
export async function runDocsEmit(deps: DocsRunDeps, runId: string): Promise<DocsAction> {
    const run = await deps.state.read(runId)
    const staging = run.staging_branch
    const base = deps.config.git.baseBranch
    const docsBranch = `docs-${runId}`
    const worktree = docsWorktreePath(deps.dataDir, runId)
    const baseRef = `origin/${base}`

    await deps.git.fetch('origin', staging)
    await deps.git.fetch('origin', base)
    // Retry-reset: the prior failed commit/edit must not bleed into the new attempt
    // (preserves "at most one docs commit" invariant).
    await ensureStageWorktree(deps.git, {
        worktree,
        ref: `origin/${staging}`,
        branch: docsBranch,
        resetIfExists: (run.docs?.attempts ?? 0) >= 1,
    })

    return {
        kind: 'spawn',
        run_id: runId,
        agent_type: AGENT_TYPE_BY_ROLE.scribe,
        worktree,
        base_ref: baseRef,
        staging_branch: staging,
        docs_branch: docsBranch,
        model: DOCS_MODEL,
        max_turns: DOCS_MAX_TURNS,
        prompt: buildScribePrompt(worktree, baseRef),
    }
}

export const DocsResultsSchema = z.object({status: z.string().min(1)}).strict()
export type DocsResults = z.infer<typeof DocsResultsSchema>

/** Record a scribe result: publish the docs commit + mark done, or suspend the run. */
export async function runDocsRecord(
    deps: DocsRunDeps,
    runId: string,
    results: DocsResults
): Promise<Extract<DocsAction, {kind: 'done' | 'suspend'}>> {
    const run = await deps.state.read(runId)
    const staging = run.staging_branch
    const docsBranch = `docs-${runId}`
    const worktree = docsWorktreePath(deps.dataDir, runId)
    const outcome = parseProducerStatus(results.status)

    if (outcome.status === 'done') {
        // docsBranch = staging tip (+ at most one docs commit) → ff-merge is clean.
        await publishToStaging(deps.git, staging, docsBranch)
        await deps.git.worktreeRemove([worktree, '--force'])
        await deps.state.update(runId, (s) => ({...s, docs: {status: 'done', ended_at: nowIso()}}))
        return {kind: 'done', run_id: runId}
    }

    // Failure: track attempts and suspend for a retry. Once the cap is hit, treat docs as
    // best-effort — finalize `done` so the run completes instead of looping infinitely.
    const reason = 'reason' in outcome ? outcome.reason : 'docs phase failed'
    const attempts = (run.docs?.attempts ?? 0) + 1
    const docsRecord = {status: 'failed' as const, reason, attempts, ended_at: nowIso()}

    if (attempts >= MAX_DOCS_ATTEMPTS) {
        // ponytail: cap hit — docs best-effort; runner proceeds to finalize instead of suspend
        await deps.state.update(runId, (s) => ({...s, docs: docsRecord}))
        return {kind: 'done', run_id: runId}
    }

    await deps.state.update(runId, (s) => ({
        ...s,
        status: 'suspended',
        docs: docsRecord,
    }))
    return {kind: 'suspend', run_id: runId, reason}
}
