/**
 * The run-level E2E COROUTINE (Decision 39) — mirrors `docs.ts`'s emit/record split,
 * ordered BEFORE it (`src/orchestrator/next.ts`'s `wantsE2e`).
 *
 * Unlike docs (one LLM pass, never re-entered), e2e has TWO very different kinds of
 * work:
 *   - AUTHORING a suite (needs an LLM + live-app exploration) — happens EXACTLY ONCE
 *     per run, on the first e2e entry (`run.e2e_phase === undefined`).
 *   - RUNNING the suite + deciding what to do with the result (fully mechanical —
 *     shells Playwright via `runE2e`, no LLM) — happens on EVERY entry, including
 *     every re-entry after a reopened task settles back to terminal.
 *
 * Spawns exist in three places (all `kind: "spawn"`, discriminated by `expects`):
 * the first-entry AUTHOR spawn, its crash-retry re-spawn (D5), and the ADJUDICATOR
 * spawn (D7 — a pre-existing committed spec failed unmappably and needs a
 * regression-vs-intentional-change ruling). Every other call drives
 * `runSuiteAndDecide` and returns a CONCLUSIVE action (`done` | `failed` |
 * `reopen` | `suspend`). The runner therefore loops while `kind === "spawn"`,
 * picking the results shape off `expects`; every other kind means "state already
 * updated, no agent needed, continue the next-task loop."
 *
 * Ordering vs. commit (a deliberate refinement over the plan's literal worked
 * example): the fail-first proof runs BEFORE the critical specs are merged into
 * staging, using the author's own (not-yet-merged) worktree as the proof's
 * "staging-side" run and a scratch worktree off the base branch as the "base-side"
 * run. A spec that fails the proof (vacuous / base-unusable) therefore NEVER lands
 * in the target repo's committed `e2e/` — only a PROVEN spec is merged. The plan's
 * literal ordering ("commit; then prove") would otherwise permanently pollute the
 * committed suite with a rejected spec on the fail path.
 *
 * Reopen mechanics reuse `resetTaskRow` (Decision 39) — the SAME primitive rescue
 * uses — with a fresh `e2eFeedback` override; `e2e_feedback` then reaches both
 * producer roles via the existing `PriorFailureNote` channel (handlers.ts).
 */
/* eslint-disable security/detect-non-literal-fs-filename -- fs on internal derived paths (run/spec/state/repo/data dirs), never external input; runtime write-danger is covered by the TCB write-deny hook */
import {copyFile, mkdir, writeFile} from 'node:fs/promises'
import {dirname, isAbsolute, join} from 'node:path'
import {
    resolveStagingBranch,
    resetTaskRow,
    parseProducerStatus,
    runE2e,
    DefaultPlaywrightTool,
    provisionWorktree,
    type Config,
    type GitClient,
    type StateManager,
    type SpecManifest,
    type RunState,
    type E2ePhase,
    type E2eAdjudication,
    type E2eAdjudicationSpec,
    type E2eManifestEntry,
    type PlaywrightTool,
    type E2eSpecResult,
    type ProvisionWorktreeFn,
} from './deps.js'
import {nonNull, nowIso, createLogger} from '../shared/index.js'
import {CONTROL_TITLE_PREFIX, E2eResultsSchema, type E2eAuthorResults} from './e2e-schemas.js'
import {
    e2eWorktreePath,
    e2eRunWorktreePath,
    e2eBaseProofWorktreePath,
    e2eThrowawayDir,
    e2eAdjudicateWorktreePath,
    e2eBranchName,
    adjudicateBranchName,
    resolveBootConfig,
    scrubbedE2eEnv,
    type BootConfig,
} from './e2e-paths.js'

// The public e2e surface now owned by the two leaf modules, re-exported so
// `orchestrator/index.ts` and `e2e.test.ts` keep importing it from `./e2e.js`
// (behavior-preserving motion — Decision 39/40 split).
export {CONTROL_TITLE_PREFIX, E2eResultsSchema, type E2eAuthorResults}
export {e2eWorktreePath, e2eRunWorktreePath, e2eBaseProofWorktreePath, e2eThrowawayDir}

const log = createLogger('e2e')

/** File operations the e2e coroutine needs beyond git — injectable (unit tests fake it). */
export interface E2eFileOps {
    /** Copies one spec file across worktrees for the fail-first proof. */
    copySpec(from: string, to: string): Promise<void>
    /** Writes a generated Playwright config (e.g. the throwaway-suite config). */
    writeConfig(path: string, contents: string): Promise<void>
}

class DefaultE2eFileOps implements E2eFileOps {
    async copySpec(from: string, to: string): Promise<void> {
        await mkdir(dirname(to), {recursive: true})
        await copyFile(from, to)
    }
    async writeConfig(path: string, contents: string): Promise<void> {
        await mkdir(dirname(path), {recursive: true})
        await writeFile(path, contents)
    }
}

export interface E2eRunDeps {
    readonly state: StateManager
    readonly git: GitClient
    readonly config: Config
    readonly dataDir: string
    /** The run's durable spec — task list + acceptance criteria for the author prompt. */
    readonly spec: SpecManifest
    /** Injectable Playwright wrapper (tests fake this; production uses the real CLI). */
    readonly playwright?: PlaywrightTool
    /** Injectable spec-file copy for the fail-first proof (tests fake this). */
    readonly files?: E2eFileOps
    /** Injectable worktree provisioner (tests fake this; production runs `npm ci`-equivalent). */
    readonly provision?: ProvisionWorktreeFn
}

export type E2eAction =
    | {
          readonly kind: 'spawn'
          /** Which results shape the runner records back (D7) — author manifest vs adjudication verdicts. */
          readonly expects: 'author-results'
          readonly run_id: string
          readonly worktree: string
          readonly base_ref: string
          readonly staging_branch: string
          readonly e2e_branch: string
          readonly throwaway_dir: string
          readonly model: string
          readonly max_turns: number
          readonly prompt: string
      }
    | {
          readonly kind: 'spawn'
          readonly expects: 'adjudication-results'
          readonly run_id: string
          readonly worktree: string
          readonly staging_branch: string
          readonly adjudicate_branch: string
          readonly model: string
          readonly max_turns: number
          readonly prompt: string
      }
    | {readonly kind: 'done'; readonly run_id: string}
    | {readonly kind: 'failed'; readonly run_id: string; readonly reason: string}
    | {
          readonly kind: 'reopen'
          readonly run_id: string
          readonly task_ids: readonly string[]
          readonly reason: string
      }
    | {readonly kind: 'suspend'; readonly run_id: string; readonly reason: string}

// Apex-pinned (Decision 40): the author runs once per run, no human reviews its
// assertions, and they gate the run — same rationale as the spec-generator pin (Decision 21).
const E2E_AUTHOR_MODEL = 'opus'
// D5 (Decision 40): a crashed/unparseable author earns ONE automatic re-spawn —
// mirrors the assessment coroutine's MAX_ASSESS_ATTEMPTS. Deliberate verdicts
// (blocked-escalate, needs-context) are FINAL and never retry.
const MAX_AUTHOR_ATTEMPTS = 2
// ponytail: 90 (docs' 60 + a 50% margin) — live MCP exploration burns more turns
// than a diff read; bump if the author routinely hits the ceiling.
const E2E_AUTHOR_MAX_TURNS = 90

/** Build the e2e-author prompt: the task list + config + the two spec destinations. */
function buildAuthorPrompt(args: {
    worktree: string
    baseRef: string
    throwawayDir: string
    testDir: string
    startCommand: string
    baseURL: string
    spec: SpecManifest
}): string {
    const taskLines = args.spec.tasks
        .map((t) => `  - ${t.task_id} — ${t.title}: ${t.acceptance_criteria.join('; ')}`)
        .join('\n')
    return [
        "You are the factory e2e-author running the pipeline's end-to-end test-authoring phase.",
        `1. cd into your worktree: ${args.worktree} (checked out on the e2e branch off the staging tip).`,
        `2. Boot the app: \`${args.startCommand}\` → ${args.baseURL} (reuse if already running).`,
        '3. Review every task this PRD delivered:',
        taskLines,
        `4. For each USER-FACING task, explore the live app via the Playwright MCP tools and author a ` +
            `THROWAWAY spec into ${args.throwawayDir} (OUTSIDE this worktree — never commit it).`,
        `5. Author a small number of CRITICAL, money-path JOURNEY specs (thin — the load-bearing net, ` +
            `not per-task coverage) into ${args.worktree}/${args.testDir}/ and COMMIT them in this worktree. ` +
            `Each critical spec MUST include one assertion titled with the "${CONTROL_TITLE_PREFIX}" prefix ` +
            'that passes on ANY boot of the app (e.g. the page loads) — the fail-first proof uses it to tell ' +
            "'the app didn't boot' apart from 'the feature doesn't exist yet.'",
        '6. Self-validate: every spec you authored must be green against the live (staging) app before you finish.',
        '7. Do NOT push (the engine merges the critical specs on record). Do NOT edit non-e2e files.',
        'Finish with your terminal STATUS line and return {"status": "<line>", "manifest": [...]} — the ' +
            'manifest is an array of {task_ids, spec_path, kind, title} rows, one per spec you authored ' +
            '(critical `spec_path` is worktree-relative; throwaway `spec_path` is throwaway-dir-relative; ' +
            '`title` is a plain-language journey name a non-technical reader understands, e.g. "Sign up and ' +
            'reach the dashboard"). EVERY file you commit under the test dir must appear as a critical ' +
            'manifest row (support helpers under support/ and auth.setup.ts excepted) — an undeclared ' +
            'committed spec is rejected at record. ' +
            'Per agents/e2e-author.md + skills/e2e-authoring/SKILL.md for the full authoring discipline.',
    ].join('\n')
}

/** Emit the e2e phase's next step: spawn the author (first entry) or run the suite directly (re-entry). */
export async function runE2eEmit(deps: E2eRunDeps, runId: string): Promise<E2eAction> {
    const run = await deps.state.read(runId)
    const cfg = deps.config.e2e

    // Backstop only (R14, Decision 40): the run-start assessment normally resolves the
    // boot pair; a legacy/assessment-skipped run with no config override lands here.
    const boot = resolveBootConfig(cfg, run)
    if (boot === null) {
        const reason =
            'e2e phase has no boot config — the run-start assessment resolved none and no ' +
            'override is set; run `factory configure --set e2e.startCommand=<cmd> ' +
            '--set e2e.baseURL=<url>` then resume'
        await deps.state.update(runId, (s) => ({...s, status: 'suspended'}))
        log.warn(`run '${runId}': ${reason}`)
        return {kind: 'suspend', run_id: runId, reason}
    }

    if (run.e2e_phase === undefined) {
        return prepareAuthorSpawn(deps, run, runId, boot, cfg.testDir)
    }

    // Author-crash re-entry (D5): author_attempts persisted with no manifest and no
    // verdict means the previous author spawn died mid-flight — re-spawn it (the
    // record leg's retryAuthorOrFail caps total attempts).
    if (
        run.e2e_phase.status === undefined &&
        run.e2e_phase.manifest.length === 0 &&
        (run.e2e_phase.author_attempts ?? 0) >= 1
    ) {
        return prepareAuthorSpawn(deps, run, runId, boot, cfg.testDir)
    }

    // In-flight adjudication (D7): the cursor survived a crash/resume — idempotently
    // re-emit the adjudicator spawn (its record leg concludes or retries it).
    if (run.e2e_phase.status === undefined && run.e2e_phase.adjudication !== undefined) {
        return prepareAdjudicatorSpawn(deps, run, runId, boot)
    }

    // Re-entry after a reopened task settled: the manifest is already authored
    // (throwaway specs are RE-RUN, not re-authored) — go straight to the mechanical
    // suite run. The fail-first proof already ran once, at authoring time.
    return runSuiteAndDecide(deps, runId)
}

async function prepareAuthorSpawn(
    deps: E2eRunDeps,
    run: RunState,
    runId: string,
    boot: BootConfig,
    testDir: string
): Promise<E2eAction> {
    const staging = resolveStagingBranch(runId, run.staging_branch)
    const base = deps.config.git.baseBranch
    const branch = e2eBranchName(runId)
    const worktree = e2eWorktreePath(deps.dataDir, runId)
    const baseRef = `origin/${base}`

    await deps.git.fetch('origin', staging)
    if (!(await deps.git.worktreeExists(worktree))) {
        // `-B` (not `-b`): a crash between this worktree's removal and the state
        // update that concludes this phase can leave the branch behind after the
        // worktree path is gone — a bare `-b` would fatal on re-entry. `-B`
        // force-creates/resets it, matching a fresh run's behavior either way.
        await deps.git.worktreeAdd(['-B', branch, worktree, `origin/${staging}`])
        await (deps.provision ?? provisionWorktree)({
            path: worktree,
            setupCommand: deps.config.quality.setupCommand,
        })
    } else if ((run.e2e_phase?.author_attempts ?? 0) >= 1) {
        // Re-spawn after a crashed author (D5): discard its partial, unmerged work so
        // attempt 2 starts from a clean staging tip, not a half-written suite.
        await deps.git.resetHardClean(`origin/${staging}`, {cwd: worktree})
    }

    const throwawayDir = e2eThrowawayDir(deps.dataDir, runId)
    return {
        kind: 'spawn',
        expects: 'author-results',
        run_id: runId,
        worktree,
        base_ref: baseRef,
        staging_branch: staging,
        e2e_branch: branch,
        throwaway_dir: throwawayDir,
        model: E2E_AUTHOR_MODEL,
        max_turns: E2E_AUTHOR_MAX_TURNS,
        prompt: buildAuthorPrompt({
            worktree,
            baseRef,
            throwawayDir,
            testDir,
            startCommand: boot.startCommand,
            baseURL: boot.baseURL,
            spec: deps.spec,
        }),
    }
}

/** Build the adjudicator prompt (D7): rule each unmapped failing spec regression vs
 * intentional-change, then rewrite every pre-authorized/ruled-intentional spec. */
function buildAdjudicationPrompt(args: {
    worktree: string
    boot: BootConfig
    cursor: E2eAdjudication
    spec: SpecManifest
}): string {
    const taskLines = args.spec.tasks
        .map((t) => `  - ${t.task_id} — ${t.title}: ${t.acceptance_criteria.join('; ')}`)
        .join('\n')
    const specLines = (rows: readonly E2eAdjudicationSpec[]): string =>
        rows
            .map((s) => {
                const detail = s.error === undefined ? '' : `\n    ${s.error.replace(/\n/g, '\n    ')}`
                return `  - ${s.spec_path} — "${s.title}"${detail}`
            })
            .join('\n')
    const adjudicate = args.cursor.specs.filter((s) => s.mode === 'adjudicate')
    const update = args.cursor.specs.filter((s) => s.mode === 'update')
    const lines = [
        'You are the factory e2e-adjudicator: pre-existing committed e2e specs are failing ' +
            'against staging and no manifest entry maps them to a task in this run. Decide ' +
            'whether each failure is a REGRESSION this run introduced or an INTENTIONAL ' +
            "behavior change this run's spec authorizes.",
        `1. cd into your worktree: ${args.worktree} (checked out on the adjudication branch off the staging tip).`,
        `2. Boot the app: \`${args.boot.startCommand}\` → ${args.boot.baseURL} (reuse if already running).`,
        "3. The tasks this run delivered (the ONLY authority for 'intentional'):",
        taskLines,
    ]
    if (adjudicate.length > 0) {
        lines.push(
            '4. ADJUDICATE each failing spec below — read its source, reproduce against the live app:',
            specLines(adjudicate),
            '   Verdict "regression": the old behavior should still work and this run broke it.',
            '   Verdict "intentional-change": a task above deliberately changed this behavior — you ' +
                'MUST include a `citation` quoting the authorizing task/criterion language verbatim; ' +
                'an uncited intentional-change verdict is rejected.'
        )
    }
    if (update.length > 0 || adjudicate.length > 0) {
        lines.push(
            `${adjudicate.length > 0 ? '5' : '4'}. UPDATE these pre-authorized specs${
                adjudicate.length > 0 ? ' plus every spec you ruled intentional-change' : ''
            } — rewrite each to assert the NEW behavior, keep its "${CONTROL_TITLE_PREFIX}"-titled ` +
                'assertion, validate it green against the live staging app, and COMMIT it in this worktree:',
            ...(update.length > 0 ? [specLines(update)] : [])
        )
    }
    lines.push(
        'Only the spec files listed above may change — touching anything else fails the run. Do NOT push.',
        'Finish with your terminal STATUS line and return {"status": "<line>", "verdicts": [...]} — ' +
            'one {spec_path, verdict, reason, citation?} row per ADJUDICATED spec only (pre-authorized ' +
            'updates need no verdict row); `reason` is plain language a non-technical reader understands.'
    )
    return lines.join('\n')
}

/** Prepare (idempotently) the adjudicator worktree + spawn off the persisted cursor (D7). */
async function prepareAdjudicatorSpawn(
    deps: E2eRunDeps,
    run: RunState,
    runId: string,
    boot: BootConfig
): Promise<E2eAction> {
    const cursor = run.e2e_phase?.adjudication
    if (cursor === undefined) {
        throw new Error(`run '${runId}': prepareAdjudicatorSpawn called with no adjudication cursor`)
    }
    const staging = resolveStagingBranch(runId, run.staging_branch)
    const branch = adjudicateBranchName(runId)
    const worktree = e2eAdjudicateWorktreePath(deps.dataDir, runId)

    await deps.git.fetch('origin', staging)
    if (!(await deps.git.worktreeExists(worktree))) {
        // `-B`: same crash-safety rationale as prepareAuthorSpawn.
        await deps.git.worktreeAdd(['-B', branch, worktree, `origin/${staging}`])
        await (deps.provision ?? provisionWorktree)({
            path: worktree,
            setupCommand: deps.config.quality.setupCommand,
        })
    } else if (cursor.attempts >= 1) {
        // Re-spawn after a crashed adjudicator: discard its partial work (mirrors D5).
        await deps.git.resetHardClean(`origin/${staging}`, {cwd: worktree})
    }

    return {
        kind: 'spawn',
        expects: 'adjudication-results',
        run_id: runId,
        worktree,
        staging_branch: staging,
        adjudicate_branch: branch,
        model: E2E_AUTHOR_MODEL,
        max_turns: E2E_AUTHOR_MAX_TURNS,
        prompt: buildAdjudicationPrompt({worktree, boot, cursor, spec: deps.spec}),
    }
}

/**
 * Guard a manifest `spec_path` before ANY filesystem `join`/`copySpec`/`testDir` use.
 * The author is an autonomous LLM — nothing here is human-reviewed before this runs
 * — so a traversal/absolute-path trick must be caught HERE, the single choke point
 * every downstream use (`proveCriticals`'s joins, `runSuiteAndDecide`'s `testDir`)
 * routes through via the persisted manifest. Throws (never silently sanitizes).
 */
function assertSafeSpecPath(specPath: string): void {
    if (isAbsolute(specPath)) {
        throw new Error(`e2e manifest spec_path '${specPath}' must be relative, not absolute`)
    }
    if (specPath.split(/[\\/]+/).includes('..')) {
        throw new Error(`e2e manifest spec_path '${specPath}' must not contain '..' segments`)
    }
}

/**
 * Fail the phase AND discard the author worktree — every {@link runE2eRecord}
 * failure exit routes through here so no early exit leaks the worktree (the
 * `worktree remove` wrapper tolerates an already-absent path: nonzero exit code,
 * not a throw).
 */
async function failWithCleanup(
    deps: E2eRunDeps,
    runId: string,
    worktree: string,
    reason: string
): Promise<Extract<E2eAction, {kind: 'failed'}>> {
    await deps.git.worktreeRemove([worktree, '--force'])
    await markFailed(deps, runId, reason)
    return {kind: 'failed', run_id: runId, reason}
}

function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

/**
 * D5 (Decision 40): an `error` verdict means the author CRASHED or returned no
 * parseable STATUS — not a deliberate refusal — so it earns one automatic re-spawn
 * (the returned action is the fresh `spawn`). At the cap the phase fails like any
 * other author failure. Deliberate verdicts never route here.
 */
async function retryAuthorOrFail(
    deps: E2eRunDeps,
    runId: string,
    worktree: string,
    reason: string
): Promise<E2eAction> {
    const run = await deps.state.read(runId)
    const attempts = (run.e2e_phase?.author_attempts ?? 0) + 1
    if (attempts >= MAX_AUTHOR_ATTEMPTS) {
        return failWithCleanup(deps, runId, worktree, `${reason} (after ${attempts} attempts)`)
    }
    await deps.state.update(runId, (s) => ({
        ...s,
        e2e_phase: {
            ...(s.e2e_phase ?? defaultE2ePhase()),
            author_attempts: attempts,
        },
    }))
    log.warn(`run '${runId}': e2e-author attempt ${attempts}/${MAX_AUTHOR_ATTEMPTS} crashed — re-spawning (${reason})`)
    return runE2eEmit(deps, runId)
}

/** Record the e2e-author's result: on failure, fail the run (crash → one re-spawn,
 * D5); on success, prove + run the suite. Widened to the FULL {@link E2eAction} —
 * the crash-retry path returns a fresh `spawn`, so runners loop while `spawn`. */
export async function runE2eRecord(deps: E2eRunDeps, runId: string, results: E2eAuthorResults): Promise<E2eAction> {
    // A persisted adjudication cursor — not anything in the results shape — is what
    // says which spawn these results answer (D7): the cursor only exists while an
    // adjudicator is in flight.
    const run0 = await deps.state.read(runId)
    if (run0.e2e_phase?.adjudication !== undefined) {
        return recordAdjudication(deps, runId, run0, results)
    }

    const worktree = e2eWorktreePath(deps.dataDir, runId)

    const outcome = parseProducerStatus(results.status)
    if (outcome.status === 'error') {
        return retryAuthorOrFail(deps, runId, worktree, `e2e-author: ${outcome.reason}`)
    }
    if (outcome.status !== 'done') {
        const reason = `e2e-author: ${'reason' in outcome ? outcome.reason : 'no parseable status'}`
        return failWithCleanup(deps, runId, worktree, reason)
    }

    if (results.manifest.length === 0 && results.no_ui_surface !== true) {
        const reason =
            'e2e-author: STATUS: DONE with an empty manifest but no_ui_surface was not ' +
            'explicitly true — ambiguous (genuine no-op vs. a malformed/incomplete ' +
            'response); refusing to silently pass'
        return failWithCleanup(deps, runId, worktree, reason)
    }

    for (const entry of results.manifest) {
        try {
            assertSafeSpecPath(entry.spec_path)
        } catch (err) {
            return failWithCleanup(deps, runId, worktree, `e2e-author: ${errText(err)}`)
        }
    }

    const cfg = deps.config.e2e
    const run = await deps.state.read(runId)
    const staging = resolveStagingBranch(runId, run.staging_branch)
    const critical = results.manifest.filter((e) => e.kind === 'critical')

    // The author picks task_ids off the spec it was handed, but nothing upstream
    // constrains it to that set — an unknown id would otherwise silently vanish at
    // reopen time (`taskIds.includes(id)` in runSuiteAndDecide just skips it).
    const unknownTaskIds = [...new Set(results.manifest.flatMap((e) => e.task_ids))].filter((id) => !(id in run.tasks))
    if (unknownTaskIds.length > 0) {
        const reason =
            `e2e-author: manifest references unknown task_id(s) not in this run: ` + unknownTaskIds.join(', ')
        return failWithCleanup(deps, runId, worktree, reason)
    }

    if (critical.length > 0) {
        // Trust boundary (Decision 39 W5): the author's ENTIRE branch is about to be
        // merged unreviewed. Every `critical` spec_path must itself live under the
        // committed testDir — a critical entry declared OUTSIDE it (e.g. repo root)
        // would otherwise merge an unreviewed file just by being self-declared as
        // "critical" (nothing else checks a critical entry's location).
        const testDirPrefix = `${cfg.testDir}/`
        const outsideTestDir = critical.filter((e) => !e.spec_path.startsWith(testDirPrefix))
        if (outsideTestDir.length > 0) {
            const reason =
                `e2e-author: critical spec_path(s) not under '${testDirPrefix}' — refusing to merge: ` +
                outsideTestDir.map((e) => e.spec_path).join(', ')
            return failWithCleanup(deps, runId, worktree, reason)
        }

        // Reject up front — before spending the fail-first proof — if the branch
        // touches anything outside testDir at all. Throwaway specs live OUTSIDE this
        // worktree (never committed, so never in this diff) — the only files a
        // legitimate author branch touches are critical specs under testDir/, so no
        // additional per-file allowlist is needed once THAT is enforced above.
        const branch = e2eBranchName(runId)
        const changed = await deps.git.diffNames(staging, branch, {cwd: worktree})
        const stray = changed.filter((f) => !f.startsWith(testDirPrefix))
        if (stray.length > 0) {
            const reason =
                `e2e-author: branch touches path(s) outside '${testDirPrefix}' — refusing to merge ` +
                `unreviewed changes: ${stray.join(', ')}`
            return failWithCleanup(deps, runId, worktree, reason)
        }

        // Converse check (D6, Decision 40): every changed file under testDir/ must be a
        // DECLARED critical manifest entry — an undeclared spec would merge with no
        // spec→task join, so its later failure could never reopen anything (a permanent
        // unmappable failure). Carve-out: shared machinery (support helpers, auth setup)
        // is legitimately not a spec and never joins to a task.
        const declared = new Set(critical.map((e) => e.spec_path))
        const undeclared = changed.filter(
            (f) =>
                !declared.has(f) && !f.startsWith(`${testDirPrefix}support/`) && f !== `${testDirPrefix}auth.setup.ts`
        )
        if (undeclared.length > 0) {
            const reason =
                `e2e-author: committed file(s) under '${testDirPrefix}' missing from the manifest — ` +
                `an undeclared spec can never be joined back to a task, refusing to merge: ` +
                undeclared.join(', ')
            return failWithCleanup(deps, runId, worktree, reason)
        }

        // Boot config can only vanish between spawn and record if config/assessment
        // state was mutated mid-run — fail loud rather than proving with a bogus boot.
        const boot = resolveBootConfig(cfg, run)
        if (boot === null) {
            return failWithCleanup(
                deps,
                runId,
                worktree,
                'e2e-author: boot config vanished between spawn and record (config or assessment state changed mid-run)'
            )
        }

        const proof = await proveCriticals(deps, runId, critical, worktree, boot)
        if (!proof.ok) {
            // Never merge an unproven spec — the worktree (and its unmerged commits) is
            // discarded rather than landed in the target repo.
            return failWithCleanup(deps, runId, worktree, proof.reason)
        }

        // Proven — merge the critical specs into staging (mirrors docs' ff-merge).
        await deps.git.mergeFfOrCommit(staging, e2eBranchName(runId))
        await deps.git.push('origin', staging)
    }
    await deps.git.worktreeRemove([worktree, '--force'])

    await deps.state.update(runId, (s) => ({
        ...s,
        e2e_phase: {
            ...(s.e2e_phase ?? defaultE2ePhase()),
            manifest: results.manifest,
        },
    }))

    return runSuiteAndDecide(deps, runId)
}

/** Fail the phase AND clear the adjudication cursor + worktree — every
 * {@link recordAdjudication} failure exit routes through here so a failed run never
 * leaves a live cursor behind (emit would re-spawn against a removed worktree). */
async function failAdjudication(
    deps: E2eRunDeps,
    runId: string,
    worktree: string,
    reason: string
): Promise<Extract<E2eAction, {kind: 'failed'}>> {
    await deps.git.worktreeRemove([worktree, '--force'])
    await deps.state.update(runId, (s) =>
        s.e2e_phase === undefined ? s : {...s, e2e_phase: {...s.e2e_phase, adjudication: undefined}}
    )
    await markFailed(deps, runId, reason)
    return {kind: 'failed', run_id: runId, reason}
}

/** Adjudicator crash/no-STATUS → one automatic re-spawn, same cap + rationale as
 * {@link retryAuthorOrFail} (D5); the attempt count lives on the cursor. */
async function retryAdjudicatorOrFail(
    deps: E2eRunDeps,
    runId: string,
    worktree: string,
    reason: string
): Promise<E2eAction> {
    const run = await deps.state.read(runId)
    const cursor = run.e2e_phase?.adjudication
    const attempts = (cursor?.attempts ?? 0) + 1
    if (attempts >= MAX_AUTHOR_ATTEMPTS) {
        return failAdjudication(deps, runId, worktree, `${reason} (after ${attempts} attempts)`)
    }
    await deps.state.update(runId, (s) =>
        s.e2e_phase?.adjudication === undefined
            ? s
            : {
                  ...s,
                  e2e_phase: {
                      ...s.e2e_phase,
                      adjudication: {...s.e2e_phase.adjudication, attempts},
                  },
              }
    )
    log.warn(
        `run '${runId}': e2e-adjudicator attempt ${attempts}/${MAX_AUTHOR_ATTEMPTS} failed — re-spawning (${reason})`
    )
    return runE2eEmit(deps, runId)
}

/**
 * Record the adjudicator's verdicts (D7): any `regression` fails the run loud with
 * the adjudicator's plain-language reason; all-intentional (verdicts complete, every
 * intentional-change cited) gates the rewritten specs exactly like fresh-authored
 * ones — diff scope, fail-first re-proof, merge — then clears the cursor, stamps the
 * per-spec adjudication count (cap 1/run), and re-runs the suite.
 */
async function recordAdjudication(
    deps: E2eRunDeps,
    runId: string,
    run: RunState,
    results: E2eAuthorResults
): Promise<E2eAction> {
    const worktree = e2eAdjudicateWorktreePath(deps.dataDir, runId)
    // Non-null by the runE2eRecord dispatch guard.
    const phase = nonNull(run.e2e_phase)
    const cursor = nonNull(phase.adjudication)

    const outcome = parseProducerStatus(results.status)
    if (outcome.status === 'error') {
        return retryAdjudicatorOrFail(deps, runId, worktree, `e2e-adjudicator: ${outcome.reason}`)
    }
    if (outcome.status !== 'done') {
        const reason = `e2e-adjudicator: ${'reason' in outcome ? outcome.reason : 'no parseable status'}`
        return failAdjudication(deps, runId, worktree, reason)
    }

    // Verdict completeness — an incomplete/malformed response is a retryable crash-
    // equivalent (the adjudicator half-finished), not a deliberate ruling.
    const verdicts = results.verdicts ?? []
    const cursorPaths = new Set(cursor.specs.map((s) => s.spec_path))
    const ruled = new Set(verdicts.map((v) => v.spec_path))
    const unruled = cursor.specs.filter((s) => s.mode === 'adjudicate' && !ruled.has(s.spec_path))
    const unknown = verdicts.filter((v) => !cursorPaths.has(v.spec_path))
    const uncited = verdicts.filter(
        (v) => v.verdict === 'intentional-change' && (v.citation === undefined || v.citation === '')
    )
    if (unruled.length > 0 || unknown.length > 0 || uncited.length > 0) {
        const parts = [
            ...(unruled.length > 0 ? [`missing verdict(s) for: ${unruled.map((s) => s.spec_path).join(', ')}`] : []),
            ...(unknown.length > 0
                ? [`verdict(s) for spec(s) not under adjudication: ${unknown.map((v) => v.spec_path).join(', ')}`]
                : []),
            ...(uncited.length > 0
                ? [
                      `intentional-change verdict(s) missing the required citation: ${uncited.map((v) => v.spec_path).join(', ')}`,
                  ]
                : []),
        ]
        return retryAdjudicatorOrFail(deps, runId, worktree, `e2e-adjudicator: ${parts.join('; ')}`)
    }

    const regressions = verdicts.filter((v) => v.verdict === 'regression')
    if (regressions.length > 0) {
        const reason =
            'e2e adjudication: regression verdict — ' + regressions.map((v) => `${v.spec_path}: ${v.reason}`).join('; ')
        return failAdjudication(deps, runId, worktree, reason)
    }

    // All intentional — gate the rewritten specs exactly like fresh-authored ones.
    const staging = resolveStagingBranch(runId, run.staging_branch)
    const changed = await deps.git.diffNames(staging, adjudicateBranchName(runId), {
        cwd: worktree,
    })
    const stray = changed.filter((f) => !cursorPaths.has(f))
    if (stray.length > 0) {
        const reason =
            'e2e-adjudicator: branch touches path(s) outside the adjudicated spec set — ' +
            `refusing to merge unreviewed changes: ${stray.join(', ')}`
        return failAdjudication(deps, runId, worktree, reason)
    }
    const unrewritten = cursor.specs.filter((s) => !changed.includes(s.spec_path))
    if (unrewritten.length > 0) {
        return retryAdjudicatorOrFail(
            deps,
            runId,
            worktree,
            `e2e-adjudicator: spec(s) not rewritten: ${unrewritten.map((s) => s.spec_path).join(', ')}`
        )
    }

    const boot = resolveBootConfig(deps.config.e2e, run)
    if (boot === null) {
        return failAdjudication(
            deps,
            runId,
            worktree,
            'e2e-adjudicator: boot config vanished between spawn and record (config or assessment state changed mid-run)'
        )
    }
    // Fail-first re-proof: the rewritten spec must be red on base (new behavior absent
    // there) and green on the adjudicator's worktree — same trust boundary as authoring.
    const proof = await proveCriticals(
        deps,
        runId,
        changed.map((f) => ({task_ids: [], spec_path: f, kind: 'critical' as const})),
        worktree,
        boot
    )
    if (!proof.ok) {
        return failAdjudication(deps, runId, worktree, `e2e adjudication re-proof: ${proof.reason}`)
    }

    await deps.git.mergeFfOrCommit(staging, adjudicateBranchName(runId))
    await deps.git.push('origin', staging)
    await deps.git.worktreeRemove([worktree, '--force'])

    await deps.state.update(runId, (s) => {
        if (s.e2e_phase === undefined) {
            return s
        }
        const counts = {...(s.e2e_phase.adjudication_counts ?? {})}
        for (const spec of cursor.specs) {
            counts[spec.spec_path] = (counts[spec.spec_path] ?? 0) + 1
        }
        return {
            ...s,
            e2e_phase: {...s.e2e_phase, adjudication: undefined, adjudication_counts: counts},
        }
    })
    log.info(`run '${runId}': e2e adjudication merged ${cursor.specs.length} updated spec(s) — re-running the suite`)
    return runSuiteAndDecide(deps, runId)
}

interface ProofVerdict {
    readonly ok: boolean
    readonly reason: string
}

/**
 * True iff at least one CONTROL spec ran and all of them passed. A critical spec
 * with NO control-titled assertion at all is NOT vacuously green — the authoring
 * contract requires one (see `buildAuthorPrompt`); without it there's no way to
 * tell "the base app didn't boot" apart from "the feature doesn't exist yet."
 */
function classifyBaseRun(specs: readonly E2eSpecResult[]): {
    hasControl: boolean
    controlGreen: boolean
    journeyRed: boolean
} {
    const control = specs.filter((s) => s.title.toLowerCase().startsWith(CONTROL_TITLE_PREFIX))
    const journey = specs.filter((s) => !s.title.toLowerCase().startsWith(CONTROL_TITLE_PREFIX))
    return {
        hasControl: control.length > 0,
        controlGreen: control.length > 0 && control.every((s) => s.status === 'passed'),
        journeyRed: journey.length > 0 && journey.every((s) => s.status === 'failed'),
    }
}

/**
 * Fail-first proof (Decision 5): each critical spec must be RED on the base branch
 * (with its control assertion GREEN — proving the base app itself booted) and GREEN
 * on the author's worktree (staging + the new spec). Guards against a green-but-
 * meaningless autonomously-authored assertion; nothing here is human-reviewed.
 */
async function proveCriticals(
    deps: E2eRunDeps,
    runId: string,
    critical: readonly E2eManifestEntry[],
    authorWorktree: string,
    boot: BootConfig
): Promise<ProofVerdict> {
    const cfg = deps.config.e2e
    const files = deps.files ?? new DefaultE2eFileOps()
    const tool = deps.playwright ?? new DefaultPlaywrightTool()
    const wtPath = e2eBaseProofWorktreePath(deps.dataDir, runId)
    const base = `origin/${deps.config.git.baseBranch}`
    if (!(await deps.git.worktreeExists(wtPath))) {
        // `-B`: same crash-safety rationale as prepareAuthorSpawn — a scratch proof
        // worktree removed by a crashed prior pass can leave its branch behind.
        await deps.git.worktreeAdd(['-B', `e2e-base-proof-${runId}`, wtPath, base])
        await (deps.provision ?? provisionWorktree)({
            path: wtPath,
            setupCommand: deps.config.quality.setupCommand,
        })
    }

    try {
        for (const entry of critical) {
            await files.copySpec(join(authorWorktree, entry.spec_path), join(wtPath, entry.spec_path))
            // runE2e THROWS on tooling-level failure (missing Playwright binary, empty/
            // truncated reporter output) — convert to a ProofVerdict so the caller's
            // failWithCleanup path persists the failure instead of an uncaught crash.
            let baseResult
            try {
                baseResult = await runE2e(
                    {
                        cwd: wtPath,
                        env: scrubbedE2eEnv(cfg, boot),
                        replaceEnv: true,
                        testDir: entry.spec_path,
                    },
                    tool
                )
            } catch (err) {
                return {
                    ok: false,
                    reason: `fail-first proof: e2e tooling error running '${entry.spec_path}' against the base app: ${errText(err)}`,
                }
            }
            const {hasControl, controlGreen, journeyRed} = classifyBaseRun(baseResult.specs)
            if (!hasControl) {
                return {
                    ok: false,
                    reason:
                        `fail-first proof: '${entry.spec_path}' has no "${CONTROL_TITLE_PREFIX}"-titled ` +
                        'assertion — cannot verify the base app booted (required by the authoring contract)',
                }
            }
            if (!controlGreen) {
                return {
                    ok: false,
                    reason:
                        `fail-first proof: base worktree unusable for '${entry.spec_path}' — ` +
                        'its control assertion failed against the unmodified base app',
                }
            }
            if (!journeyRed) {
                return {
                    ok: false,
                    reason:
                        `fail-first proof: '${entry.spec_path}' did not fail against the base app ` +
                        '(vacuous-pass risk) — rejected',
                }
            }
            let stagingResult
            try {
                stagingResult = await runE2e(
                    {
                        cwd: authorWorktree,
                        env: scrubbedE2eEnv(cfg, boot),
                        replaceEnv: true,
                        testDir: entry.spec_path,
                    },
                    tool
                )
            } catch (err) {
                return {
                    ok: false,
                    reason: `fail-first proof: e2e tooling error running '${entry.spec_path}' against staging: ${errText(err)}`,
                }
            }
            if (!stagingResult.ok) {
                return {
                    ok: false,
                    reason: `fail-first proof: '${entry.spec_path}' is still red against staging`,
                }
            }
        }
        return {ok: true, reason: ''}
    } finally {
        await deps.git.worktreeRemove([wtPath, '--force'])
    }
}

/** The zero-value `e2e_phase` shape (no manifest authored yet, no reopens spent). Every
 * writer spreads this under `s.e2e_phase ??` so a first write never has to restate it. */
function defaultE2ePhase(): Pick<E2ePhase, 'manifest' | 'reopen_counts'> {
    return {manifest: [], reopen_counts: {}}
}

async function markDone(
    deps: E2eRunDeps,
    runId: string,
    opts: {attempts: number; advisory?: string | undefined}
): Promise<void> {
    await deps.state.update(runId, (s) => ({
        ...s,
        e2e_phase: {
            ...(s.e2e_phase ?? defaultE2ePhase()),
            status: 'done' as const,
            reason: undefined,
            advisory: opts.advisory,
            attempts: opts.attempts,
            ended_at: nowIso(),
        },
    }))
}

async function markFailed(deps: E2eRunDeps, runId: string, reason: string, attempts?: number): Promise<void> {
    await deps.state.update(runId, (s) => ({
        ...s,
        e2e_phase: {
            ...(s.e2e_phase ?? defaultE2ePhase()),
            status: 'failed' as const,
            reason,
            advisory: undefined,
            attempts: attempts ?? s.e2e_phase?.attempts,
            ended_at: nowIso(),
        },
    }))
    log.warn(`run '${runId}': e2e phase failed — ${reason}`)
}

/** Where the generated throwaway-suite Playwright config lives — inside the run
 * worktree (never committed, never staged) so its own `require("@playwright/test")`
 * resolves via THAT worktree's `node_modules`, even though `testDir` inside it
 * points at the out-of-repo throwaway dir. */
function throwawayConfigPath(worktree: string): string {
    return join(worktree, '.factory-e2e-throwaway.config.cjs')
}

/** CommonJS (not TS/ESM) — loads regardless of the target repo's package.json `type`. */
function throwawayConfigContents(throwawayDir: string): string {
    return [
        '// Generated by the factory e2e coroutine — never commit, rewritten every run.',
        'const { defineConfig } = require("@playwright/test");',
        'module.exports = defineConfig({',
        `  testDir: ${JSON.stringify(throwawayDir)},`,
        '  use: { baseURL: process.env.BASE_URL },',
        '  webServer: {',
        '    command: process.env.FACTORY_E2E_START_COMMAND,',
        '    url: process.env.BASE_URL,',
        '    reuseExistingServer: process.env.FACTORY_E2E ? false : true,',
        '    timeout: Number(process.env.FACTORY_E2E_READY_TIMEOUT_MS) || 30_000,',
        '  },',
        '});',
        '',
    ].join('\n')
}

/** One join hit: a failed spec + the manifest entry that names it, or `undefined` if unmapped. */
function findEntry(manifest: readonly E2eManifestEntry[], spec: E2eSpecResult): E2eManifestEntry | undefined {
    return manifest.find((e) => specPathMatches(spec.file, e.spec_path))
}

/** Bidirectional suffix match — the Playwright reporter's `file` and the assessment
 * map's `spec_path` may each carry or lack the testDir prefix. The SINGLE join predicate
 * for both the manifest (findEntry / criticalMisses) and assessment sides — a one-directional
 * variant here false-misses a passing prefixed critical and reopens an all-green suite to death. */
function specPathMatches(file: string, specPath: string): boolean {
    return file === specPath || file.endsWith(`/${specPath}`) || specPath.endsWith(`/${file}`)
}

/** A tooling-level failure (nonzero exit / reporter `errors[]`) that no individual spec's
 * status explains — unattributable to any task, so the run fails outright rather than
 * absorbing it into a critical-miss reopen. */
function unattributableToolingFailure(r: {readonly ok: boolean; readonly specs: readonly E2eSpecResult[]}): boolean {
    return !r.ok && r.specs.every((s) => s.status !== 'failed')
}

/**
 * The mechanical heart of the phase: sync the run-worktree to CURRENT staging, run
 * the full suite (critical + throwaway), join failures to tasks via the manifest,
 * and apply the cadence + disposition (Decision 39) rules.
 */
async function runSuiteAndDecide(deps: E2eRunDeps, runId: string): Promise<E2eAction> {
    const run = await deps.state.read(runId)
    const manifest = run.e2e_phase?.manifest ?? []
    const attempts = (run.e2e_phase?.attempts ?? 0) + 1
    const firstPass = attempts === 1
    const cfg = deps.config.e2e

    if (manifest.length === 0) {
        // The author judged nothing in this PRD to be UI-facing — nothing to gate on.
        await markDone(deps, runId, {attempts})
        return {kind: 'done', run_id: runId}
    }

    // Emit's suspend backstop gates entry, but this leg is also reached from record —
    // a mid-run config/assessment mutation must fail loud, not boot a fabricated app.
    const boot = resolveBootConfig(cfg, run)
    if (boot === null) {
        const reason = 'e2e suite has no boot config — the run-start assessment resolved none and no override is set'
        await markFailed(deps, runId, reason, attempts)
        return {kind: 'failed', run_id: runId, reason}
    }

    const staging = resolveStagingBranch(runId, run.staging_branch)
    const worktree = e2eRunWorktreePath(deps.dataDir, runId)
    const provision = deps.provision ?? provisionWorktree
    await deps.git.fetch('origin', staging)
    if (!(await deps.git.worktreeExists(worktree))) {
        // `-B`: same crash-safety rationale as prepareAuthorSpawn.
        await deps.git.worktreeAdd(['-B', `e2e-run-${runId}`, worktree, `origin/${staging}`])
    } else {
        // Always resync — a reopened task's re-ship advanced staging since the last pass.
        await deps.git.resetHardClean(`origin/${staging}`, {cwd: worktree})
    }
    // Provisioned on first creation AND every resync — staging may have gained a
    // new dependency between reopen passes.
    await provision({path: worktree, setupCommand: deps.config.quality.setupCommand})

    const tool = deps.playwright ?? new DefaultPlaywrightTool()
    // runE2e THROWS on a tooling-level failure (missing Playwright binary, empty/
    // truncated reporter output) — persist a failed phase instead of crashing the
    // record with the phase cursor left dangling.
    let criticalResult
    try {
        criticalResult = await runE2e(
            {cwd: worktree, env: scrubbedE2eEnv(cfg, boot), replaceEnv: true, testDir: cfg.testDir},
            tool
        )
    } catch (err) {
        const reason = `e2e critical suite tooling error: ${errText(err)}`
        await markFailed(deps, runId, reason, attempts)
        return {kind: 'failed', run_id: runId, reason}
    }
    const throwaway = manifest.filter((e) => e.kind === 'throwaway')
    let throwawayResult
    let throwawayThrew: string | undefined
    if (throwaway.length > 0) {
        const throwawayDir = e2eThrowawayDir(deps.dataDir, runId)
        const configPath = throwawayConfigPath(worktree)
        await (deps.files ?? new DefaultE2eFileOps()).writeConfig(configPath, throwawayConfigContents(throwawayDir))
        try {
            throwawayResult = await runE2e(
                {cwd: worktree, env: scrubbedE2eEnv(cfg, boot), replaceEnv: true, config: configPath},
                tool
            )
        } catch (err) {
            if (firstPass) {
                const reason = `e2e throwaway suite tooling error: ${errText(err)}`
                await markFailed(deps, runId, reason, attempts)
                return {kind: 'failed', run_id: runId, reason}
            }
            // Pass 2+ throwaway is non-gating (Decision 39) — fold the crash into the
            // advisory below instead of failing the run.
            throwawayThrew = errText(err)
        }
    }

    // A manifest `critical` entry only counts as proven when ITS spec is present in the
    // results AND passed/flaky — absent (never collected) or explicitly failed/skipped
    // are all the same non-pass outcome. Stop treating "no spec in `failed`" as a pass.
    const criticalEntries = manifest.filter((e) => e.kind === 'critical')
    const criticalMisses = criticalEntries
        .map((entry) => ({
            entry,
            spec: criticalResult.specs.find((s) => specPathMatches(s.file, entry.spec_path)),
        }))
        .filter((m) => m.spec === undefined || (m.spec.status !== 'passed' && m.spec.status !== 'flaky'))

    // A tooling-level failure (nonzero exit / reporter errors[]) that no individual
    // spec's status explains can't be attributed to any task — fail the run outright
    // rather than silently absorbing it into a critical-miss reopen.
    if (unattributableToolingFailure(criticalResult)) {
        const reason =
            'e2e critical suite reported a tooling failure (nonzero exit code or reporter ' +
            'errors[]) with no individual spec marked failed — refusing to attribute to a task'
        await markFailed(deps, runId, reason, attempts)
        return {kind: 'failed', run_id: runId, reason}
    }

    // Same tooling-failure blind spot as above, but for the throwaway run: a broken
    // throwaway config/tool invocation (`ok:false`, no spec marked `failed`) would
    // otherwise fall through to an empty `throwawayFailed` and silently `markDone`.
    // Only gate on pass 1 — pass 2+ throwaway is already non-gating (Decision 39), so
    // a tooling failure there is folded into the advisory instead (see below).
    if (firstPass && throwawayResult && unattributableToolingFailure(throwawayResult)) {
        const reason =
            'e2e throwaway suite reported a tooling failure (nonzero exit code or reporter ' +
            'errors[]) with no individual spec marked failed — refusing to attribute to a task'
        await markFailed(deps, runId, reason, attempts)
        return {kind: 'failed', run_id: runId, reason}
    }

    const criticalSpecFailures = criticalResult.specs.filter((s) => s.status === 'failed')
    const throwawayFailed = throwawayResult?.specs.filter((s) => s.status === 'failed') ?? []
    const unmappableCritical = criticalSpecFailures.filter((s) => findEntry(manifest, s) === undefined)

    // Unmappable = a PRE-EXISTING committed spec (this run's manifest doesn't name it)
    // is failing. Route three ways off the assessment's affected-specs forecast (D7):
    // mapped should-still-pass → reopen its tasks like any manifest failure;
    // needs-update → adjudicator in pre-authorized update mode; unmapped/unforecast →
    // adjudicator rules regression vs intentional-change. One adjudication per spec
    // per run — failing AGAIN after its update merged is a regression, fail loud.
    const stillPass: {spec: E2eSpecResult; entry: E2eManifestEntry}[] = []
    if (unmappableCritical.length > 0) {
        const affected = run.e2e_assessment?.affected_specs ?? []
        const counts = run.e2e_phase?.adjudication_counts ?? {}
        const readjudicated: string[] = []
        const cursorSpecs: E2eAdjudicationSpec[] = []
        for (const s of unmappableCritical) {
            const row = affected.find((r) => specPathMatches(s.file, r.spec_path))
            const specPath =
                row?.spec_path ?? (s.file.startsWith(`${cfg.testDir}/`) ? s.file : `${cfg.testDir}/${s.file}`)
            if ((counts[specPath] ?? 0) >= 1) {
                readjudicated.push(specPath)
            } else if (row?.expectation === 'should-still-pass') {
                stillPass.push({
                    spec: s,
                    entry: {task_ids: [...row.task_ids], spec_path: row.spec_path, kind: 'critical'},
                })
            } else {
                cursorSpecs.push({
                    spec_path: specPath,
                    title: s.title,
                    ...(s.error !== undefined ? {error: s.error} : {}),
                    mode: row?.expectation === 'needs-update' ? 'update' : 'adjudicate',
                })
            }
        }
        if (readjudicated.length > 0) {
            const reason =
                'pre-existing e2e spec(s) failing AGAIN after their one adjudication — treating ' +
                `as a regression: ${readjudicated.join(', ')}`
            await markFailed(deps, runId, reason, attempts)
            return {kind: 'failed', run_id: runId, reason}
        }
        if (cursorSpecs.length > 0) {
            // Task-attributed reopens (stillPass + any mappable misses) wait for the
            // post-adjudication suite re-run — one decision at a time. Suite `attempts`
            // is deliberately NOT persisted here: this pass didn't conclude, and the
            // re-run recomputes the same value.
            await deps.state.update(runId, (st) => ({
                ...st,
                e2e_phase: {
                    ...(st.e2e_phase ?? defaultE2ePhase()),
                    adjudication: {specs: cursorSpecs, attempts: 0, requested_at: nowIso()},
                },
            }))
            log.info(`run '${runId}': ${cursorSpecs.length} pre-existing failing spec(s) sent to adjudication`)
            return prepareAdjudicatorSpawn(deps, await deps.state.read(runId), runId, boot)
        }
    }

    // Cadence (Decision 39): pass 1 reopens for ANY mappable failure (critical + throwaway);
    // pass 2+ reopens ONLY for critical. A still-red throwaway on pass 2+ is dropped here —
    // it never blocks (only critical red gates disposition) and never reopens.
    const throwawayCandidates = firstPass
        ? throwawayFailed
              .map((spec) => ({spec, entry: findEntry(manifest, spec)}))
              .filter((m): m is {spec: E2eSpecResult; entry: E2eManifestEntry} => m.entry !== undefined)
        : []
    const mappable: {spec?: E2eSpecResult | undefined; entry: E2eManifestEntry}[] = [
        ...criticalMisses,
        ...throwawayCandidates,
        ...stillPass,
    ]

    if (mappable.length === 0) {
        // Pass 2+ throwaway tooling failures never gate (Decision 39), but must still
        // surface — otherwise this branch would silently `markDone` past a broken
        // throwaway run.
        const throwawayToolingFailed =
            !firstPass &&
            (throwawayThrew !== undefined ||
                (throwawayResult !== undefined && unattributableToolingFailure(throwawayResult)))
        const advisory =
            throwawayFailed.length > 0
                ? `${throwawayFailed.length} throwaway spec(s) still red (non-gating): ` +
                  throwawayFailed.map((s) => s.title).join(', ')
                : throwawayToolingFailed
                  ? 'throwaway suite reported a tooling failure (non-gating)'
                  : undefined
        await markDone(deps, runId, {attempts, advisory})
        return {kind: 'done', run_id: runId}
    }

    const taskIds = [...new Set(mappable.flatMap((m) => m.entry.task_ids))]
    const reopenCounts = {...(run.e2e_phase?.reopen_counts ?? {})}
    const capExhausted = taskIds.filter((id) => (reopenCounts[id] ?? 0) >= cfg.reopenCap)
    if (capExhausted.length > 0) {
        const reason = `e2e reopen cap (${cfg.reopenCap}) exhausted for task(s): ${capExhausted.join(', ')}`
        await markFailed(deps, runId, reason, attempts)
        return {kind: 'failed', run_id: runId, reason}
    }

    const feedback =
        'The e2e phase found these journeys still failing:\n' +
        mappable
            .map((m) => {
                const title = m.spec ? m.spec.title : 'did not run (missing from results)'
                // D8 (Decision 40): the failing assertion/step, already ANSI-stripped +
                // byte-capped by the runner — without it a reopened producer starts blind.
                const detail =
                    m.spec?.error != null && m.spec.error.length > 0 ? `\n  ${m.spec.error.replace(/\n/g, '\n  ')}` : ''
                return `- ${m.entry.spec_path} — "${title}"${detail}`
            })
            .join('\n')
    for (const id of taskIds) {
        reopenCounts[id] = (reopenCounts[id] ?? 0) + 1
    }

    await deps.state.update(runId, (s) => ({
        ...s,
        tasks: Object.fromEntries(
            Object.entries(s.tasks).map(([id, t]) =>
                taskIds.includes(id) ? [id, resetTaskRow(t, {e2eFeedback: feedback, clearShippedPr: true})] : [id, t]
            )
        ),
        e2e_phase: {
            ...(s.e2e_phase ?? defaultE2ePhase()),
            status: undefined,
            reason: undefined,
            advisory: undefined,
            attempts,
            manifest, // already `run.e2e_phase?.manifest` (read at the top of this function) — s.e2e_phase can't have diverged since
            reopen_counts: reopenCounts,
        },
    }))
    log.info(`run '${runId}': e2e reopening task(s) ${taskIds.join(', ')} (pass ${attempts})`)
    return {kind: 'reopen', run_id: runId, task_ids: taskIds, reason: feedback}
}
