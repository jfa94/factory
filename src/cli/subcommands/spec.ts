/**
 * `factory spec <resolve|gate|store>` — the CLI wrapper over the deterministic
 * spec-build seam. The testable cores (`resolveSpec`/`gateSpec`/`storeSpec` +
 * the `SpecBuildEnvelope`/`SpecBuildDeps` runner contract) live in
 * `src/spec/build.ts` — see its header for the full runner-owned loop; this
 * file owns only flag parsing, production dep wiring, and envelope emission.
 * The moved names are re-exported below for existing importers.
 */
import {EXIT, type ExitCode} from '../../shared/exit-codes.js'
import {parseArgs, UsageError, optionalString} from '../args.js'
import {emitJson, emitLine, emitError, emitHelp} from '../io.js'
import {loadConfig, resolveDataDir} from '../../config/index.js'
import {defaultSpecBuildRoot} from '../../core/state/paths.js'
import {StateManager} from '../../core/state/index.js'
import {StatuslineUsageSignal} from '../../quota/index.js'
import {nowEpoch} from '../../shared/time.js'
import {
    SpecStore,
    RealGhClient,
    resolveSpec,
    gateSpec,
    storeSpec,
    type SpecBuildDeps,
    type SpecBuildEnvelope,
} from '../../spec/index.js'
import {DefaultGitClient, resolveRepo, type GitClient} from '../../git/index.js'
import {withUsageGuard, type Subcommand} from '../registry-types.js'

export {resolveSpec, gateSpec, storeSpec}
export type {SpecBuildDeps, SpecBuildEnvelope}

const SPEC_HELP = `factory spec — deterministic spec-build seam (resolve → gate → store)

Usage:
  factory spec resolve [--repo <owner/name>] --issue <n> [--supersede] [--ignore-quota]
  factory spec gate    [--repo <owner/name>] --issue <n>
  factory spec store   [--repo <owner/name>] --issue <n>

--repo is OPTIONAL: auto-derived from the 'origin' remote when omitted; an explicit
value that disagrees with the remote fails loud.

The in-session runner drives the agent spawns; the ENGINE bounds the regen loop
(scratch attempts.json; over spec.maxRegenIterations → terminal spec-defect, exit 1)
and quota-gates resolve (pause envelope; --ignore-quota overrides). Each action emits
ONE JSON envelope naming the next step. Scratch JSON is threaded through the OS temp
dir, factory-spec-build/<repo>/<issue>/{prd,generated,verdict,attempts}.json
(transient pre-validation agent output, never the plugin data dir).

Actions:
  resolve  Reuse an existing spec by issue, else fetch the PRD + emit the generate spawn.
  gate     Run the deterministic spec gates; emit revise (blockers) or the review spawn.
  store    Adjudicate the review (56/60 + floor); emit revise or persist + emit the pointer.`

function parseIssue(raw: string): number {
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0) {
        throw new UsageError(`--issue must be a positive integer, got '${raw}'`)
    }
    return n
}

/** Wire production deps once (own wiring — no run exists at spec time, so NOT loadCliDeps). */
function wireDeps(): SpecBuildDeps {
    const dataDir = resolveDataDir({})
    const config = loadConfig({dataDir})
    return {
        store: new SpecStore({dataDir}),
        gh: new RealGhClient({bodyMaxBytes: config.spec.prdBodyMaxBytes}),
        config,
        usage: new StatuslineUsageSignal({dataDir}),
        now: nowEpoch,
        scratchRoot: defaultSpecBuildRoot(),
    }
}

/**
 * The `--supersede` weekly-parked pre-check: mirrors the `resolveOrCreateRun` weekly
 * wall (lifecycle.ts) BEFORE Phase 1 regenerates anything. Without it the regen loop
 * would replace the parked run's durable spec, and Phase 2's wall would then refuse
 * the supersede — stranding the parked run with a dangling spec pointer. Read-only;
 * honors `--ignore-quota` at the call site. Returns null when nothing blocks (no
 * active run, or an active run supersede may proceed against). Exported for tests.
 */
export async function weeklyParkedPause(repo: string, issue: number): Promise<SpecBuildEnvelope | null> {
    const run = await new StateManager({}).findActiveByIssue(repo, issue)
    const quota = run?.quota
    if (run?.status !== 'suspended' || quota?.binding_window !== '7d') {
        return null
    }
    return {
        kind: 'pause',
        repo,
        issue,
        scope: '7d',
        reason:
            `run '${run.run_id}' is weekly-parked (7d quota window); superseding would strand it — ` +
            `resume with /factory:resume after the window resets, or pass --ignore-quota`,
        resets_at_epoch: quota.resets_at_epoch,
    }
}

type Action = (deps: SpecBuildDeps, repo: string, issue: number) => Promise<SpecBuildEnvelope>

const ACTIONS: Record<string, Action> = {
    resolve: resolveSpec,
    gate: gateSpec,
    store: storeSpec,
}

/**
 * Test seam for {@link run}'s repo resolution: inject the git seam + cwd so the
 * `--repo` auto-derive path (Prompt G) is exercised with a fake remote.
 */
export interface SpecRepoOverrides {
    readonly gitClient?: GitClient
    readonly cwd?: string
}

/**
 * Resolve the spec target's `owner/name` — `--repo` is OPTIONAL (Prompt G),
 * auto-derived from the origin remote when omitted; an explicit value that
 * disagrees with the remote fails loud.
 */
export async function resolveSpecRepo(
    args: ReturnType<typeof parseArgs>,
    overrides: SpecRepoOverrides = {}
): Promise<string> {
    return resolveRepo({
        explicit: optionalString(args.flag('repo')),
        cwd: overrides.cwd ?? process.cwd(),
        gitClient: overrides.gitClient ?? new DefaultGitClient(),
    })
}

async function run(argv: string[]): Promise<ExitCode> {
    const action = argv[0]
    if (action === undefined || action === '--help' || action === '-h') {
        emitLine(SPEC_HELP)
        return EXIT.OK
    }

    const handler = ACTIONS[action]
    if (handler === undefined) {
        throw new UsageError(`unknown spec action '${action}' (expected resolve | gate | store)`)
    }

    const args = parseArgs(argv.slice(1), {booleans: ['supersede', 'ignore-quota']})
    if (args.flag('help') === true) {
        return emitHelp(SPEC_HELP)
    }

    // Validate the required --issue FIRST (synchronous usage edge), then resolve the
    // optional --repo (may probe git) — so a missing/invalid issue stays a fast USAGE.
    const issue = parseIssue(args.requireFlag('issue'))
    const repo = await resolveSpecRepo(args)
    const supersede = args.flag('supersede') === true
    const ignoreQuota = args.flag('ignore-quota') === true

    if (action === 'resolve' && supersede && !ignoreQuota) {
        const parked = await weeklyParkedPause(repo, issue)
        if (parked !== null) {
            emitJson(parked)
            return specExitCode(parked)
        }
    }

    const deps = wireDeps()
    const envelope =
        action === 'resolve'
            ? await resolveSpec(deps, repo, issue, {regenerate: supersede, ignoreQuota})
            : await handler(deps, repo, issue)
    emitJson(envelope)
    if (envelope.kind === 'unspecifiable') {
        emitError(
            `PRD #${issue} is not specifiable — fix the PRD and re-run:\n` +
                envelope.blockers.map((b) => `  - ${b}`).join('\n')
        )
    }
    if (envelope.kind === 'spec-defect') {
        emitError(
            `spec regeneration bound exhausted for #${issue} ` +
                `(${envelope.iterations}/${envelope.max_iterations}) — rework the PRD (or raise ` +
                `spec.maxRegenIterations) and re-run; latest blockers:\n` +
                envelope.blockers.map((b) => `  - ${b}`).join('\n')
        )
    }
    return specExitCode(envelope)
}

/**
 * Envelope → exit code (S9): the two terminal refusals — `unspecifiable`
 * (pre-generation) and `spec-defect` (regen bound exhausted) — are the only
 * non-zero spec outcomes; everything else is a loop step. The frozen exit enum
 * has no "needs-human" code (see src/shared/exit-codes.ts); ERROR is correct —
 * the envelope `kind` on stdout is the machine discriminator.
 */
export function specExitCode(envelope: SpecBuildEnvelope): ExitCode {
    return envelope.kind === 'unspecifiable' || envelope.kind === 'spec-defect' ? EXIT.ERROR : EXIT.OK
}

export const specCommand: Subcommand = {
    describe: 'Build a durable spec (resolve → gate → store; runner drives the agent spawns)',
    run: withUsageGuard('spec', run),
}
