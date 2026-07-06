/**
 * `factory run <create|resume|finalize|docs|cancel>` — the run-lifecycle entrypoint (C6).
 *
 * Model A: the CLI never spawns an agent. `run create` resolves a DURABLE spec (by
 * stable issue number or explicit spec-id), creates a fresh run, SEEDS its task
 * rows from the spec, and emits the {@link RunState}; the in-session runner
 * reads `run_id` and drives the run through the orchestrator seam (`factory next-task` +
 * `factory next-action`).
 *
 * `run resume` is the human-invoked resumable entrypoint (Decision 24, Δ F — v1 is
 * HUMAN relaunch only; the v2 scheduler would fire this same path). It re-reads the
 * LIVE quota window through the pure {@link planResume} seam and, when the binding
 * window has recovered, clears the checkpoint and returns the run to `running`;
 * otherwise it reports why resume did not proceed and leaves state untouched. A
 * terminal run is a LOUD error — there is nothing to resume.
 *
 * Seeding maps each {@link SpecTask} to a `pending` {@link TaskState} carrying ONLY
 * the dependency edges (a frozen denormalization for hot DAG traversal) — never the
 * `risk_tier` dial (read live from the spec via `specTaskOf`, derive-don't-store)
 * and never `tdd_exempt` (read from `spec/tasks.json` at runtime, never from
 * `state.json`). Dangling,
 * self, cyclic, and duplicate dependency edges are caught LOUDLY at seed time rather
 * than surfacing later as a orchestrator deadlock.
 */
import {join} from 'node:path'
import {EXIT, type ExitCode} from '../../shared/exit-codes.js'
import {parseArgs, UsageError, optionalString, parseResultsFlag} from '../args.js'
import {emitJson, emitLine, emitError} from '../io.js'
import {loadConfig, resolveDataDir} from '../../config/index.js'
import {StateManager, specDir} from '../../core/state/index.js'
import {SpecStore} from '../../spec/index.js'
import {makeRunId, validateId} from '../../shared/ids.js'
import {nowEpoch} from '../../shared/time.js'
import {nonNull} from '../../shared/index.js'
import {StatuslineUsageSignal} from '../../quota/index.js'
import type {RunState} from '../../types/index.js'
import {
    finalizeRun,
    runDocsEmit,
    runDocsRecord,
    DocsResultsSchema,
    runE2eEmit,
    runE2eRecord,
    E2eResultsSchema,
    runAssessmentEmit,
    runAssessmentRecord,
    AssessmentResultsSchema,
    runTraceabilityEmit,
    runTraceabilityRecord,
    TraceabilityResultsSchema,
    readJsonInput,
} from '../../orchestrator/index.js'
import {loadCliDeps, type CliDeps} from '../wiring.js'
import {emitMetric} from '../../scoring/index.js'
import {
    DefaultGitClient,
    DefaultGhClient,
    resolveStagingBranch,
    resolveRepo,
    splitRepoSlug,
    type GitClient,
    type GhClient,
} from '../../git/index.js'
import {readCurrentForCwd, type CurrentRunOverrides} from '../current.js'
import {requireAutonomousMode} from '../../autonomy/mode.js'
import {withUsageGuard, type Subcommand} from '../registry-types.js'
import {
    resolveOrCreateRun,
    applyResume,
    type SpecSelector,
    type RunIntent,
    type RunStagingDeps,
} from '../../orchestrator/lifecycle.js'
import {assertE2ePrereqs, assertGateContract} from '../../orchestrator/preflight.js'

const RUN_HELP = `factory run — create or resume a run

Usage:
  factory run create [--repo <owner/name>] (--issue <n> | --spec-id <id>) [--run-id <id>]
  factory run resume [--run <id>]
  factory run finalize [--run <id>] [--no-ship]
  factory run traceability [--run <id>] [--results <path>]
  factory run docs [--run <id>] [--results <path>]
  factory run e2e [--run <id>] [--results <path>]
  factory run e2e-assess [--run <id>] [--results <path>]
  factory run cancel [--run <id>] [--cleanup] [--session-id <id>]

Actions:
  create     Resolve a durable spec, create a run, seed its tasks, emit the RunState.
  resume     Re-check the live quota window; clear the checkpoint if it has recovered.
  finalize   Build the run report, post the deduped PRD failure comment, ship the rollup only when completed, flip terminal.
  traceability  Emit the PRD-traceability audit spawn request, or (with --results) record the auditor's verdicts.
  docs       Emit the documentation-phase spawn request, or (with --results) record a scribe result.
  e2e        Emit the e2e-phase spawn request, or (with --results) record the e2e author's manifest.
  e2e-assess Emit the run-start e2e-assessment spawn request, or (with --results) record the assessor's verdict.
  cancel     Abandon a live run (mark it failed; not resumable); --cleanup also tears down its branch.`

const CREATE_HELP = `factory run create — create a run and seed its tasks from a durable spec

Usage:
  factory run create [--repo <owner/name>] (--issue <n> | --spec-id <id>) [--run-id <id>] [--new | --supersede | --resume] [--no-ship] [--ignore-quota] [--e2e] [--approve-spec] [--session-id <id>]

  --repo        OPTIONAL. Repo identity 'owner/name' (the first key of the spec store).
                Auto-derived from the 'origin' remote when omitted; an explicit value
                that disagrees with the remote fails loud.
  --issue       PRD issue number — the STABLE lookup key (reruns reuse the spec).
  --spec-id     Explicit '<issue>-<slug>' spec id (alternative to --issue).
  --run-id      Override the generated 'run-YYYYMMDD-HHMMSS' id (determinism/tests).
                A named id is an address: it forces a fresh imperative create.
  --new         Force a fresh run even if a live one already exists for this spec.
  --supersede   Terminate the active run for this spec, then create a fresh one.
  --resume      Continue the active run for this spec (full hand-off: forthcoming).
  --no-ship     Open the rollup PR but never merge. Default (no flag): live — auto-merge
                each task into staging and merge the staging→develop rollup into develop.
                Persisted on the run so resume + finalize read it without re-passing.
  --ignore-quota Bypass the weekly-quota hard stop AND the per-step quota pacer for this run.
                Persisted as ignore_quota:true so the orchestrator skips the gate
                without re-passing — lets create/--supersede proceed past a 7d-parked run.
  --e2e         Opt into the run-level e2e phase (Decision 39): after all tasks are terminal,
                author + run Playwright journeys against staging before docs/finalize; a
                mappable failing journey reopens its task with feedback. Persisted as e2e:true.
  --approve-spec Park the fully-created run (suspended, no quota checkpoint) for human spec
                sign-off before any agent runs (S9, Decision 47). The envelope names the
                spec.md to review; 'factory resume' IS the sign-off. Create-only; default off.
  --session-id  Owning Claude Code session id for the session-scoped Stop gate (Prompt J).
                Defaults to $CLAUDE_CODE_SESSION_ID; required — an ownerless run is rejected.

Resolves the spec via the durable store (LOUD if none exists — generate one first).
On an ACTIVE run for this (repo, spec_id): exits CONFLICT (3) and reports it — pass
--resume to continue it or --supersede to replace it; --new (or an explicit --run-id)
forces a fresh run regardless. Seeds one pending task per spec task and emits the
RunState JSON (run_id is the top-level field).`

const RESUME_HELP = `factory run resume — re-check quota and resume a paused/suspended run

Usage:
  factory run resume [--run <id>]

  --run   The run to resume (defaults to runs/current).

Emits ONE JSON envelope:
  { kind:"resumed", run }                              — window recovered (or already running)
  { kind:"pause", run_id, status, reason, … }  — window has not recovered (state untouched)
  { kind:"debug-resume", run_id, run }         — a /factory:debug run; resume it via factory debug

A terminal run is a loud error (nothing to resume).`

const FINALIZE_HELP = `factory run finalize — turn an all-terminal run into its shipped outcome

Usage:
  factory run finalize [--run <id>] [--no-ship]

  --run       The run to finalize (defaults to runs/current).
  --no-ship   Open the rollup PR but never merge it — overrides the run's persisted ship
              mode for THIS finalize only. Default: honor the persisted ship_mode (live
              merges the staging→develop rollup; no-merge opens it only).

Builds the deterministic partial-run report (report.md), emits run.finalized
telemetry, on a failed run comments the failed tasks on the PRD issue (deduped),
opens + CI-gates + (when shipping live) squash-merges the staging→develop rollup,
then flips the run terminal — in that resume-safe order. LOUD if any task is still
non-terminal.

Emits ONE JSON envelope:
  { kind:"finalized", run, report, rollup?, failure_comment_posted }`

const CANCEL_HELP = `factory run cancel — abandon a live run (mark it failed; not resumable)

Usage:
  factory run cancel [--run <id>] [--cleanup] [--session-id <id>]

  --run         The run to cancel. Default: the active run THIS session owns
                (--session-id / $CLAUDE_CODE_SESSION_ID), else runs/current.
  --cleanup     Also tear down the run's staging branch + task PRs (like --supersede).
                Default: leave them in place for manual handling.
  --session-id  Owning session id used to locate the run when --run is omitted
                (defaults to $CLAUDE_CODE_SESSION_ID).

The explicit abandon verb: marks the run 'failed' via the one sanctioned state writer —
works even with a task still executing (no rollup CI, no ship). Idempotent; a run already
terminal as completed/superseded is a LOUD error. NOT resumable (cancelled is terminal) —
start a fresh run instead. (A session no longer needs this to stop: the Stop hook lets a
session end and leaves the run resumable; cancel is for deliberately discarding a run.)

Emits ONE JSON envelope:
  { kind:"cancelled", run, cleaned_up }`

// ---------------------------------------------------------------------------
// Flag parsing + command wiring
// ---------------------------------------------------------------------------

function parseIssue(raw: string | boolean | undefined): number | undefined {
    if (raw === undefined) {
        return undefined
    }
    if (typeof raw !== 'string') {
        throw new UsageError('--issue requires a value')
    }
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0) {
        throw new UsageError(`--issue must be a positive integer, got '${raw}'`)
    }
    return n
}

/**
 * Resolve the owning Claude Code session id to stamp onto the run (Prompt J —
 * session-scoped Stop gate). Precedence: an explicit `--session-id` flag (the
 * runner/command can pass it deterministically) over the `CLAUDE_CODE_SESSION_ID`
 * env var that Claude Code sets for Bash-tool invocations. Returns `undefined` when
 * neither is available. `run create` rejects an undefined result (the Stop hook
 * resolves the session's own run via `findActiveByOwner`, which requires an owner).
 */
export function resolveOwnerSession(
    flag: string | boolean | undefined,
    env: NodeJS.ProcessEnv = process.env
): string | undefined {
    return optionalString(flag) ?? optionalString(env.CLAUDE_CODE_SESSION_ID)
}

/**
 * Test seam for {@link runCreate}: inject the git seam + gh client + cwd + data dir
 * so the `--repo` auto-derive path (Prompt G) and the staging cut + protect
 * (Decision 33) are exercised with fakes and a temp data dir. Production passes
 * none of these (real clients, real `process.cwd()`, env-resolved data dir).
 */
export interface RunCreateOverrides {
    readonly gitClient?: GitClient
    readonly ghClient?: GhClient
    readonly cwd?: string
    readonly dataDir?: string
}

export async function runCreate(argv: string[], overrides: RunCreateOverrides = {}): Promise<ExitCode> {
    const args = parseArgs(argv, {
        booleans: ['new', 'no-ship', 'supersede', 'resume', 'ignore-quota', 'e2e', 'approve-spec'],
    })
    if (args.flag('help') === true) {
        emitLine(CREATE_HELP)
        return EXIT.OK
    }
    // Mandatory autonomous-mode gate: the pipeline runs unattended, no opt-out.
    // A run can only be born in the foreground runner session (which has the
    // env), so gating create here halts non-autonomous runs at the source.
    requireAutonomousMode()

    // --repo is OPTIONAL (Prompt G): auto-derive from the origin remote when omitted,
    // and fail LOUD if an explicit value disagrees with the remote.
    const cwd = overrides.cwd ?? process.cwd()
    const gitClient = overrides.gitClient ?? new DefaultGitClient()
    const repoSlug = await resolveRepo({
        explicit: optionalString(args.flag('repo')),
        cwd,
        gitClient,
    })
    const issue = parseIssue(args.flag('issue'))
    const specId = optionalString(args.flag('spec-id'))
    // Collapse the two CLI flags into the exactly-one SpecSelector here, at the
    // command boundary, so the rest of create works with the type-enforced invariant.
    let selector: SpecSelector
    if (issue !== undefined && specId !== undefined) {
        throw new UsageError('run create: pass exactly one of --issue or --spec-id')
    } else if (issue !== undefined) {
        selector = {issue}
    } else if (specId !== undefined) {
        selector = {specId}
    } else {
        throw new UsageError('run create requires --issue <n> or --spec-id <id>')
    }
    const explicitRunId = optionalString(args.flag('run-id'))
    const runId = explicitRunId ?? makeRunId()
    validateId(runId, 'run-id')
    // Terse boolean override over the no-flag default (live). Resolves to a CONCRETE
    // value so the reuse guard can compare the caller's intent against an existing
    // run — a bare re-create of a `--no-ship` run must not silently reuse it under
    // the (different) default intent.
    const shipMode: RunState['ship_mode'] = args.flag('no-ship') === true ? 'no-merge' : 'live'
    const ownerSession = resolveOwnerSession(args.flag('session-id'))
    // Runs must be owned: the Stop hook resolves the session's own run via
    // findActiveByOwner, which never matches an ownerless run.
    if (ownerSession === undefined) {
        throw new UsageError(
            'run create: runs require an owning session id ' + '(pass --session-id <id> or set CLAUDE_CODE_SESSION_ID).'
        )
    }
    // Exactly-one-of the lifecycle flags → the typed intent. --new and an explicit
    // --run-id both mean "fresh" (a named id is an address — determinism/tests — not a
    // reuse request, so it never silently resolves to a different run). On an ACTIVE run,
    // the "default" intent reports it as kind:"exists" (CONFLICT) — never a silent reuse.
    const fresh = args.flag('new') === true || explicitRunId !== undefined
    const supersede = args.flag('supersede') === true
    const resume = args.flag('resume') === true
    // --no-ship/--e2e are CREATE-ONLY selectors; --resume continues a run whose
    // ship_mode + e2e are already fixed (immutable post-create). The combo is
    // incoherent — reject it loud here, before any orchestrator launches.
    if (resume && (args.flag('no-ship') === true || args.flag('e2e') === true)) {
        throw new UsageError(
            'run create: --no-ship/--e2e are create-only and cannot combine with --resume — ' +
                'a resumed run keeps the ship_mode/e2e it was created with. Drop the flag to continue ' +
                'the existing run, or use --supersede to start fresh.'
        )
    }
    // S9 (Decision 47): --approve-spec is a create-only park; resuming IS the sign-off.
    const approveSpec = args.flag('approve-spec') === true
    if (approveSpec && resume) {
        throw new UsageError(
            'run create: --approve-spec is create-only and cannot combine with --resume — ' +
                'resuming a parked run IS the spec sign-off.'
        )
    }
    const picked = [supersede && 'supersede', resume && 'resume', fresh && 'fresh'].filter(
        Boolean
    ) as RunIntent['intent'][]
    if (picked.length > 1) {
        throw new UsageError('run create: pass at most one of --new / --supersede / --resume')
    }
    const intent: NonNullable<RunIntent['intent']> = picked[0] ?? 'default'
    const ignoreQuota = args.flag('ignore-quota') === true
    const e2e = args.flag('e2e') === true
    if (e2e) {
        await assertE2ePrereqs(cwd)
    }
    // Contract precondition applies to run BIRTH only — `--resume` continues an
    // existing run, and pre-contract in-flight runs must stay resumable (their
    // sweeps take the GateRunner legacy path + warn instead).
    if (intent !== 'resume') {
        await assertGateContract(cwd, gitClient)
    }
    const hasDataDirOverride = overrides.dataDir !== undefined

    const dataDir = resolveDataDir(hasDataDirOverride ? {dataDir: overrides.dataDir} : {})
    const config = loadConfig(hasDataDirOverride ? {dataDir} : {})
    const state = new StateManager({dataDir})
    const specStore = new SpecStore({dataDir})
    // Decision 33: build the staging deps bundle (git + gh + config + root + repo
    // coords) so createRunFromManifest can cut + protect staging-<run-id> from develop.
    const ghClient = overrides.ghClient ?? new DefaultGhClient()
    const {owner, repo} = splitRepoSlug(repoSlug)
    // D2: resolve the repo root the SAME way the runner skill does
    // (`git rev-parse --show-toplevel`) so both agree on the orchestrator-worktree dir
    // even if the CLI is invoked from a subdir. Staging is checked out there, not in cwd.
    const repoRoot = await gitClient.showToplevel({cwd})
    const stagingDeps: RunStagingDeps = {
        gitClient,
        ghClient,
        config,
        targetRoot: cwd,
        orchestratorWorktreePath: join(repoRoot, '.claude', 'worktrees', `orchestrator-${runId}`),
        owner,
        repo,
    }
    const result = await resolveOrCreateRun(
        state,
        specStore,
        {
            repo: repoSlug,
            runId,
            ...selector,
            shipMode,
            ownerSession,
            ...(ignoreQuota ? {ignoreQuota} : {}),
            ...(e2e ? {e2e} : {}),
            intent,
        },
        stagingDeps
    )
    if (result.kind === 'pause') {
        const r = result.existing
        const resets = r.quota && r.quota.binding_window !== 'unavailable' ? r.quota.resets_at_epoch : undefined
        emitJson({
            kind: 'pause',
            scope: '7d',
            run_id: r.run_id,
            status: r.status,
            reason: `weekly quota window has not reset; run '${r.run_id}' is parked until the 7d window resets`,
            ...(resets !== undefined ? {resets_at_epoch: resets} : {}),
        })
        emitError(
            `run create: run '${r.run_id}' is parked on a weekly quota (7d) — ` +
                `resume after the window resets with /factory:resume, or pass --ignore-quota to override`
        )
        return EXIT.CONFLICT
    }
    if (result.kind === 'exists') {
        emitJson({
            kind: 'exists',
            existing: {run_id: result.existing.run_id, status: result.existing.status},
        })
        emitError(
            `run create: active run '${result.existing.run_id}' already exists — ` +
                `pass --resume to continue it or --supersede to replace it`
        )
        return EXIT.CONFLICT
    }
    // S9 (Decision 47): --approve-spec parks the FULLY-created run (staging cut,
    // tasks seeded) for human spec sign-off — ONE suspend write, NO quota checkpoint
    // (A2: a non-quota suspend never writes one). `factory resume` clears it (the
    // sign-off); the runner session STOPS on the parked envelope instead of looping.
    const park = async (run: RunState) => {
        const parked = await state.update(run.run_id, (s) => ({
            ...s,
            status: 'suspended' as const,
        }))
        return {
            run: parked,
            spec_approval: {
                spec_path: join(specDir(dataDir, repoSlug, run.spec.spec_id), 'spec.md'),
                note: 'run parked for spec approval — review the spec, then run `factory resume`',
            },
        }
    }
    // S11: mirror the human_touches appends to metrics.jsonl (observability only —
    // the derived metric reads state, never this stream).
    await emitMetric(dataDir, result.run.run_id, 'human_touch', {kind: 'launch'})
    const out = approveSpec ? await park(result.run) : {run: result.run}
    if (result.kind === 'created') {
        emitJson({kind: 'created', ...out})
        return EXIT.OK
    }
    // kind === "superseded"
    await emitMetric(dataDir, result.run.run_id, 'human_touch', {kind: 'conflict'})
    emitJson({kind: 'superseded', ...out, supersededId: result.supersededId})
    return EXIT.OK
}

async function runResume(argv: string[]): Promise<ExitCode> {
    const args = parseArgs(argv, {booleans: ['no-ship', 'ignore-quota', 'e2e']})
    if (args.flag('help') === true) {
        emitLine(RESUME_HELP)
        return EXIT.OK
    }
    // --no-ship/--e2e select ship/e2e at CREATE; a resumed run keeps them as born
    // (immutable). Silently ignoring these flags here is the quieter twin of the
    // create-side footgun — reject loud so neither path can ever imply them on resume.
    if (args.flag('no-ship') === true || args.flag('e2e') === true) {
        throw new UsageError(
            'run resume: --no-ship/--e2e are not valid on resume — a run keeps the ' +
                'ship_mode/e2e it was created with.'
        )
    }
    // Mandatory autonomous-mode gate (see runCreate): resume re-activates a run and
    // runs in the foreground `/factory:run resume` session, which has the env.
    requireAutonomousMode()

    const dataDir = resolveDataDir({})
    const config = loadConfig({dataDir})
    const state = new StateManager({dataDir})
    const runId = await resolveRunId(state, args, 'resume')

    // --ignore-quota: persist on the run BEFORE applyResume so planResume short-circuits
    // to resume regardless of the live reading. Persisting also prevents re-suspension on
    // subsequent steps (both orchestrators read run.ignore_quota via the gate).
    if (args.flag('ignore-quota') === true) {
        await state.update(runId, (s) => ({...s, ignore_quota: true}))
    }

    const reading = await new StatuslineUsageSignal({dataDir}).read()
    const envelope = await applyResume(state, runId, reading, config, nowEpoch())
    if (envelope.kind === 'resumed' && envelope.cleared === true) {
        await emitMetric(dataDir, runId, 'human_touch', {kind: 'resume'}) // S11 mirror
    }
    emitJson(envelope)
    return EXIT.OK
}

/**
 * Resolve `runId` from `--run`, falling back to `runs/current` (LOUD if neither is
 * available — the shared head of `resume`/`finalize`, which both default to the
 * active run).
 */
async function resolveRunId(
    state: StateManager,
    args: ReturnType<typeof parseArgs>,
    action: string,
    overrides: CurrentRunOverrides = {}
): Promise<string> {
    const explicit = optionalString(args.flag('run'))
    if (explicit !== undefined) {
        return explicit
    }
    const current = await readCurrentForCwd(state, overrides)
    if (current === null) {
        throw new UsageError(`run ${action}: no --run given and no current run`)
    }
    return current.run_id
}

async function runFinalize(argv: string[]): Promise<ExitCode> {
    const args = parseArgs(argv, {booleans: ['no-ship']})
    if (args.flag('help') === true) {
        emitLine(FINALIZE_HELP)
        return EXIT.OK
    }

    // --no-ship forces no-merge for THIS finalize; otherwise honor the run's persisted
    // ship_mode (loadCliDeps falls back to it — never a hard-coded default).
    const shipMode: RunState['ship_mode'] | undefined = args.flag('no-ship') === true ? 'no-merge' : undefined
    const dataDir = resolveDataDir({})
    const state = new StateManager({dataDir})
    const runId = await resolveRunId(state, args, 'finalize')

    const deps = await loadCliDeps({
        dataDir,
        runId,
        ...(shipMode !== undefined ? {shipMode} : {}),
    })
    const {run, report, rollup, failureCommentPosted} = await finalizeRun(deps, runId)
    emitJson({
        kind: 'finalized',
        run,
        report,
        ...(rollup !== undefined ? {rollup} : {}),
        failure_comment_posted: failureCommentPosted,
    })
    return EXIT.OK
}

const DOCS_HELP = `factory run docs [--run <id>] [--results <path>]

Emit the documentation-phase spawn request, or (with --results) record a scribe
result: publish the docs commit onto staging and mark the phase done, or suspend
the run on failure. The CLI never spawns scribe — a orchestrator does.`

/**
 * Shared body of the docs/e2e phase subcommands: resolve the run, then either
 * record `--results` or emit the phase's spawn request. The CLI never spawns
 * the agent — a orchestrator does.
 */
function phaseCommand<R>(opts: {
    help: string
    phase: string
    parse: (raw: unknown) => R
    record: (deps: CliDeps, runId: string, results: R) => Promise<unknown>
    emit: (deps: CliDeps, runId: string) => Promise<unknown>
}): (argv: string[]) => Promise<ExitCode> {
    return async (argv) => {
        const args = parseArgs(argv, {booleans: []})
        if (args.flag('help') === true) {
            emitLine(opts.help)
            return EXIT.OK
        }
        const dataDir = resolveDataDir({})
        const state = new StateManager({dataDir})
        const runId = await resolveRunId(state, args, opts.phase)
        const deps = await loadCliDeps({dataDir, runId})
        const results = await parseResultsFlag(args, async (path) => opts.parse(await readJsonInput<unknown>(path)))
        emitJson(results !== undefined ? await opts.record(deps, runId, results) : await opts.emit(deps, runId))
        return EXIT.OK
    }
}

const runDocs = phaseCommand({
    help: DOCS_HELP,
    phase: 'docs',
    parse: (raw) => DocsResultsSchema.parse(raw),
    record: runDocsRecord,
    emit: runDocsEmit,
})

const TRACE_HELP = `factory run traceability [--run <id>] [--results <path>]

Emit the PRD-traceability audit spawn request (S9, Decision 47), or (with
--results) record the auditor's per-requirement verdicts: all met/partial →
phase done; any unmet → run condemned (finalize blocks the rollup); a crashed
auditor retries once, then fails the run. The CLI never spawns the auditor — a
orchestrator does.`

const runTraceability = phaseCommand({
    help: TRACE_HELP,
    phase: 'traceability',
    parse: (raw) => TraceabilityResultsSchema.parse(raw),
    record: runTraceabilityRecord,
    emit: runTraceabilityEmit,
})

const E2E_HELP = `factory run e2e [--run <id>] [--results <path>]

Emit the e2e-phase spawn request (author or run-suite, Decision 39), or (with
--results) record the e2e-author's manifest: prove + commit critical journeys,
run the full suite against staging, and either mark the phase done, reopen a
mappable failing task with feedback, or fail the run. The CLI never spawns the
e2e author — a orchestrator does.`

const runE2ePhase = phaseCommand({
    help: E2E_HELP,
    phase: 'e2e',
    parse: (raw) => E2eResultsSchema.parse(raw),
    record: runE2eRecord,
    emit: runE2eEmit,
})

const E2E_ASSESS_HELP = `factory run e2e-assess [--run <id>] [--results <path>]

Emit the run-start e2e-assessment spawn request (Decision 40), or (with --results)
record the assessor's verdict: merge validated machinery (e2e/** +
playwright.config.ts only) and persist the coverage forecast, retry a crashed
assessor once, or fail the run LOUD on a boot/machinery-impossible verdict
(every non-terminal task swept blocked-environmental). The CLI never spawns the
assessor — a orchestrator does.`

const runE2eAssess = phaseCommand({
    help: E2E_ASSESS_HELP,
    phase: 'e2e-assess',
    parse: (raw) => AssessmentResultsSchema.parse(raw),
    record: runAssessmentRecord,
    emit: runAssessmentEmit,
})

/**
 * Test seam for {@link runCancel}: inject the gh client (the `--cleanup` teardown),
 * the git client + cwd (current-run repo resolution), and the data dir. Production
 * passes none (real clients, real `process.cwd()`, env-resolved data dir).
 */
export interface RunCancelOverrides {
    readonly ghClient?: GhClient
    readonly gitClient?: GitClient
    readonly cwd?: string
    readonly dataDir?: string
}

/**
 * Resolve the run `cancel` abandons. Precedence: explicit `--run`; else the single
 * active run THIS session owns ({@link StateManager.findAllActiveByOwner} — robust to a
 * detached/repointed `runs/current`, the exact stuck-session condition); else the
 * current run for the checkout. LOUD if none resolves — and LOUD (demanding `--run`)
 * when the session owns ≥2 live runs: guessing which to abandon could finalize the
 * WRONG run, so ambiguity is surfaced, never silently fallen through to the pointer.
 *
 * Unlike {@link resolveRunId} (resume/finalize), the owner-scan is interposed BEFORE
 * the current-pointer fallback: a trapped session always knows its own session id but
 * may have lost the pointer, so the owned run must win. Explicit `--run` stays a
 * deliberate operator override with NO ownership check — the cross-session escape
 * hatch a crashed owner's run needs (single-operator local trust model), consistent
 * with how `resume`/`finalize` honor `--run`.
 */
async function resolveCancelRunId(
    state: StateManager,
    args: ReturnType<typeof parseArgs>,
    sessionId: string | undefined,
    overrides: CurrentRunOverrides = {}
): Promise<string> {
    const explicit = optionalString(args.flag('run'))
    if (explicit !== undefined) {
        return explicit
    }
    if (sessionId !== undefined) {
        const owned = await state.findAllActiveByOwner(sessionId)
        if (owned.length === 1) {
            return nonNull(owned[0]).run_id
        }
        if (owned.length >= 2) {
            const ids = owned.map((r) => r.run_id).join(', ')
            throw new UsageError(
                `run cancel: session '${sessionId}' owns ${owned.length} live runs (${ids}); ` +
                    `pass --run <id> to choose which to cancel`
            )
        }
        // owned.length === 0 → fall through to the current pointer (the run for this checkout).
    }
    const current = await readCurrentForCwd(state, overrides)
    if (current === null) {
        throw new UsageError('run cancel: no --run given and no owned/current run to cancel')
    }
    return current.run_id
}

/**
 * `factory run cancel` — explicitly abandon a live run (Decision 35). Marks the run
 * `failed` DIRECTLY via {@link StateManager.finalize} — NOT {@link finalizeRun}: cancel must
 * not attempt rollup CI / ship of a partial run. `finalize` validates only that the TARGET
 * status is terminal (it does not inspect task statuses), so a run with a task still
 * `executing` is cancellable — the exact mechanism `--supersede` already uses. Idempotent for
 * `failed`; an already completed/superseded run hits the loud "already terminal" guard.
 *
 * NO {@link requireAutonomousMode}: cancel is a terminal/cleanup op that must work from ANY
 * session (including a non-autonomous one), like `finalize` — not a run-starter. It is NOT
 * required to let a session stop (the Stop hook no longer blocks on pending work); it is the
 * verb for deliberately discarding a run you do not intend to resume.
 */
export async function runCancel(argv: string[], overrides: RunCancelOverrides = {}): Promise<ExitCode> {
    const args = parseArgs(argv, {booleans: ['cleanup']})
    if (args.flag('help') === true) {
        emitLine(CANCEL_HELP)
        return EXIT.OK
    }

    const dataDir = resolveDataDir(overrides.dataDir !== undefined ? {dataDir: overrides.dataDir} : {})
    const state = new StateManager({dataDir})
    const sessionId = resolveOwnerSession(args.flag('session-id'))
    const currentOverrides: CurrentRunOverrides = {
        ...(overrides.gitClient !== undefined ? {gitClient: overrides.gitClient} : {}),
        ...(overrides.cwd !== undefined ? {cwd: overrides.cwd} : {}),
    }
    const runId = await resolveCancelRunId(state, args, sessionId, currentOverrides)

    // Mark terminal via the one sanctioned writer (the CLI bypasses the TCB write-deny
    // hook by design — it guards Edit/Write tools, not the engine's own fs writes).
    const run = await state.finalize(runId, 'failed')

    const cleanup = args.flag('cleanup') === true
    // Resolve the PINNED branch (Decision 33) so any teardown targets the branch the run
    // actually cut, never a recompute a mid-run rename could have desynced.
    const branch = resolveStagingBranch(run.run_id, run.staging_branch)
    let cleanedUp = false
    let cleanupError: string | undefined
    if (cleanup) {
        // Reuse the supersede teardown: protection FIRST (GitHub blocks deleting a protected
        // ref), then delete staging-<run-id> (auto-closing its task PRs). Repo coords come from
        // the run's OWN spec pointer — cancel needs no cwd/--repo.
        const ghClient = overrides.ghClient ?? new DefaultGhClient()
        const {owner, repo} = splitRepoSlug(run.spec.repo)
        try {
            await ghClient.deleteProtection(owner, repo, branch)
            await ghClient.deleteRemoteBranch(owner, repo, branch)
            cleanedUp = true
        } catch (err) {
            // The run is ALREADY failed — cancel's PRIMARY contract (abandon) is met. A genuine
            // teardown throw (401/403/5xx; already-gone 404/422 is
            // tolerated upstream by the gh client) must NOT fail the abandon: surface it LOUD
            // and exit OK. Retry is safe — deleteProtection/deleteRemoteBranch tolerate an
            // already-gone branch and finalize is idempotent for `failed`.
            cleanupError = err instanceof Error ? err.message : String(err)
        }
    }

    emitJson({
        kind: 'cancelled',
        run,
        cleaned_up: cleanedUp,
        ...(cleanupError !== undefined ? {cleanup_error: cleanupError} : {}),
    })
    if (cleanupError !== undefined) {
        emitError(
            `run ${run.run_id} cancelled (marked failed), but --cleanup did NOT finish for staging ` +
                `branch '${branch}': ${cleanupError}. The branch may still exist — re-run ` +
                `\`factory run cancel --run ${run.run_id} --cleanup\` to retry the teardown.`
        )
    } else {
        emitError(
            `run ${run.run_id} cancelled (marked failed)` +
                (cleanup
                    ? `; staging branch '${branch}' + its task PRs torn down.`
                    : `; staging branch '${branch}' left in place — delete it manually or re-run with --cleanup.`)
        )
    }
    return EXIT.OK
}

async function run(argv: string[]): Promise<ExitCode> {
    const action = argv[0]
    if (action === undefined || action === '--help' || action === '-h') {
        emitLine(RUN_HELP)
        return EXIT.OK
    }
    const rest = argv.slice(1)
    switch (action) {
        case 'create':
            return runCreate(rest)
        case 'resume':
            return runResume(rest)
        case 'finalize':
            return runFinalize(rest)
        case 'traceability':
            return runTraceability(rest)
        case 'docs':
            return runDocs(rest)
        case 'e2e':
            return runE2ePhase(rest)
        case 'e2e-assess':
            return runE2eAssess(rest)
        case 'cancel':
            return runCancel(rest)
        default:
            throw new UsageError(
                `unknown run action '${action}' (expected create | resume | finalize | traceability | docs | e2e | e2e-assess | cancel)`
            )
    }
}

export const runCommand: Subcommand = {
    describe: 'Create or resume a run (create resolves+seeds a spec; resume re-checks quota)',
    run: withUsageGuard('run', run),
}

/** Top-level `factory resume` — alias-equivalent of `run resume` (Decision 35). */
export const resumeCommand: Subcommand = {
    describe: 'Resume a paused/suspended run (re-check quota; clear a recovered checkpoint)',
    run: withUsageGuard('resume', runResume),
}
