/**
 * `factory scaffold` — prepare a target repo to be run by the factory (WS3 / Δ A).
 *
 *   factory scaffold [--repo <owner/name>] [--provision]
 *
 * `--repo` is OPTIONAL (Prompt G / F-repo): auto-derived from the `origin` remote
 * when omitted (the CLI is always cwd-rooted in the target repo).
 *
 * Idempotently copies the per-repo COMMITTED artifacts the new design consumes —
 * the CI net (`.github/workflows/quality-gate.yml`, Δ Z) and the gate configs
 * (`.stryker.config.json` mutation, `.dependency-cruiser.cjs` arch, `eslint.config.mjs`
 * lint baseline) the GateRunner runs in the target worktree — plus a `.gitignore`
 * guard, then PROBES branch protection on `develop` (the integration base):
 * refuse-to-run when it is missing (#2 / Δ A), unless `--provision` is opted in to
 * write it. Per-run staging branches (`staging-<run-id>`) are minted at `run create`
 * — scaffold no longer creates or protects a shared `staging` branch.
 *
 * Run/spec STATE is never written here (it lives outside the repo under the data
 * dir). The bash-era progress files + init.sh are dropped — the new code does not
 * read them; partial-run reporting lands in WS12.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- fs on internal derived paths (run/spec/state/repo/data dirs), never external input; runtime write-danger is covered by the TCB write-deny hook */
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join, relative} from 'node:path'
import {fileURLToPath} from 'node:url'

import {EXIT, type ExitCode} from '../../shared/exit-codes.js'
import {parseArgs, optionalString} from '../args.js'
import {emitJson, emitLine} from '../io.js'
import {createLogger} from '../../shared/index.js'
import {
    DefaultGitClient,
    DefaultGhClient,
    probeProtection,
    requireProtectionOrRefuse,
    provisionProtection,
    resolveRepo,
    splitRepoSlug,
    type GitClient,
    type GhClient,
} from '../../git/index.js'
import {loadConfig, resolveDataDir, type Config} from '../../config/index.js'
import {applyGateEnvDetection, injectGateEnvIntoWorkflow, type DetectReport} from '../../ci/index.js'
import {ensureTargetSettings, buildTargetDataDirRules, type TargetDataDirRules} from './target-settings.js'
import {ensureGateContract, recommendFastCheck} from './scaffold-gates.js'
import {GATE_CONTRACT_REL} from '../../verifier/deterministic/gate-contract.js'
import type {GateContractStack} from '../../verifier/deterministic/gate-contract.js'
import {UsageError} from '../../shared/usage-error.js'
import {withUsageGuard, type Subcommand} from '../registry-types.js'

const log = createLogger('scaffold')

const HELP = `factory scaffold — prepare a repo for the factory pipeline

Usage:
  factory scaffold [--repo <owner/name>] [--provision] [--waive mutation|coverage]

Copies the committed CI + gate-config templates and probes branch protection on
develop (the integration base). Without --provision a repo whose develop branch is
not protected (strict up-to-date + required checks) causes scaffold to REFUSE loudly.
Per-run staging branches are minted at run create — scaffold no longer touches them.
Also auto-detects the repo's CI build env and gap-fills quality.gateEnv (the same
detection as 'factory configure --detect-gate-env'), captured BEFORE the managed
quality-gate.yml template overwrites the repo's own workflow.

Options:
  --repo <owner/name>   OPTIONAL. Target GitHub repo (used for the protection probe).
                        Auto-derived from the 'origin' remote when omitted; an
                        explicit value disagreeing with the remote fails loud.
  --provision           Write branch protection if missing (default: refuse)
  --waive mutation      Record the mutation gate as deliberately waived in the gate
                        contract instead of refusing when stryker is not installed
  --waive coverage      Record the coverage gate as deliberately waived instead of
                        refusing when no vitest coverage provider is installed

Also resolves + writes the GATE CONTRACT (.factory/gates.json, Decision 46): the
committed per-gate applicability agreement. Refuses below the floor (test + type +
build equivalents must be contractable). COMMIT the file — 'factory run' requires
it tracked. The contract is seed-like: an existing valid gates.json is never
touched — delete it and re-scaffold to pick up new resolution rules (e.g. the
S8 coverage flip).`

/**
 * The `.gitignore` lines scaffold guarantees. Two invariants drive the list:
 *
 *   - The TRACKED/IGNORED split inside `.claude/` is made EXPLICIT — each ignored
 *     `.claude/` child (per-machine local state) is enumerated individually so the
 *     guarantee never relies on a wildcard, a global `core.excludesfile`, or Claude
 *     Code's own gitignore management. Crucially `.claude/` is NOT ignored wholesale
 *     and `.claude/settings.json` is NOT listed, so the factory-emitted
 *     `.claude/settings.json` stays TRACKED while `.claude/settings.local.json`
 *     (per-machine overrides) is IGNORED.
 *   - Factory + worktree state (`.claude-plugin-data/`, `*.worktree`) must never be
 *     committed.
 *
 * NOTE: `docs/factory/**` (the generated spec.md + tasks.json a run mirrors into the
 * repo) is deliberately NOT ignored — it is tracked as durable, PR-reviewable
 * provenance of the spec that drove each merged PR.
 */
const GITIGNORE_ENTRIES = [
    '# Claude Code local state (factory scaffold guarantee)',
    '.claude/worktrees/',
    '.claude/plugins/',
    '.claude/file-history/',
    '.claude/backups/',
    '.claude/debug/',
    '.claude/todos/',
    '.claude/plans/',
    '.claude/memory/',
    '.claude/statsig/',
    '.claude/cache/',
    '.claude/paste-cache/',
    '.claude/projects/',
    '.claude/shell-snapshots/',
    '.claude/tasks/',
    '.claude/telemetry/',
    '.claude/workflows/',
    '.claude/history.jsonl',
    '.claude/CLAUDE.local.md',
    '.claude/tool-audit.jsonl',
    '.claude/settings.local.json',
    '# factory plugin state',
    '.claude-plugin-data/',
    '*.worktree',
]

/** Injectable inputs to the scaffold CORE (the `run(argv)` wrapper wires real ones). */
export interface ScaffoldOptions {
    /** The repo working tree to scaffold (defaults to cwd in the CLI wrapper). */
    readonly targetRoot: string
    /** The plugin `templates/` dir (resolved from the bundle location by default). */
    readonly templatesDir: string
    readonly owner: string
    readonly repo: string
    readonly config: Config
    readonly ghClient: GhClient
    /**
     * The baked, CLI-resolved data-dir permission rules for the target repo's
     * `.claude/settings.json` (from {@link buildTargetDataDirRules}). Injected at
     * the command boundary — `run(argv)` resolves the canonical data dir via
     * `resolveDataDir()` (which corrects the foreign-plugin env-var leak) so the
     * emitted rules never carry the broken `${CLAUDE_PLUGIN_DATA}` placeholder.
     */
    readonly dataDirRules: TargetDataDirRules
    /**
     * The CLI-resolved factory data dir (where the config overlay lives). Threaded
     * into CI build-env detection so the gateEnv gap-fill writes the SAME overlay
     * the rest of the factory reads — and so the injectable scaffold core stays pure
     * of the ambient `$CLAUDE_PLUGIN_DATA` (units inject a temp dir).
     */
    readonly dataDir: string
    /** --provision: write protection when missing instead of refusing. */
    readonly provision: boolean
    /** --waive mutation: record the mutation gate as waived instead of refusing. */
    readonly waiveMutation?: boolean
    /** --waive coverage: record the coverage gate as waived instead of refusing. */
    readonly waiveCoverage?: boolean
}

/** Machine-readable scaffold report (emitted as JSON). */
export interface ScaffoldReport {
    readonly repo: string
    readonly files_created: string[]
    readonly files_present: string[]
    /**
     * Plugin-MANAGED template files (the CI net) that drifted from the shipped
     * template and were AUTO-OVERWRITTEN on this run. The plugin is their sole
     * author; git is the safety net (the change shows in `git diff`).
     */
    readonly files_updated: string[]
    readonly protection: {
        readonly enabled: boolean
        readonly strict_up_to_date: boolean
        readonly required_status_checks: string[]
        readonly provisioned: boolean
    }
    /**
     * E1 (F-perm): the target `.claude/settings.json` emit/merge — whether the
     * file was freshly created and whether the merge altered it. Stops the
     * per-call permission prompts for interactive `/factory:run` in this repo.
     */
    readonly settings: {readonly created: boolean; readonly changed: boolean}
    /** Detected stack driving the gate-contract resolution (S7, Decision 46). */
    readonly stack: GateContractStack
    /** Whether `.factory/gates.json` was freshly resolved+written or already present. */
    readonly gates_contract: 'created' | 'present'
    /**
     * CI build-env auto-detection: the gateEnv gap-fill run BEFORE the managed
     * `quality-gate.yml` template overwrites the repo's own workflow, capturing the
     * repo author's build env into the durable config overlay. Omitted when nothing
     * was detected (no workflows / no literal env), so a brand-new repo's report is
     * unchanged.
     */
    readonly gateEnv?: DetectReport
}

/**
 * Resolve the plugin `templates/` directory from this module's runtime location.
 * The build inlines this module into `dist/factory.js` (repo root → `templates/`);
 * in dev it runs from `src/cli/subcommands/` (four up → `templates/`). Walk up
 * until a dir with the CI template is found.
 */
export function resolveTemplatesDir(): string {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 6; i++) {
        const candidate = join(dir, 'templates')
        if (existsSync(join(candidate, '.github', 'workflows', 'quality-gate.yml'))) {
            return candidate
        }
        const parent = dirname(dir)
        if (parent === dir) {
            break
        }
        dir = parent
    }
    throw new Error('scaffold: could not locate the plugin templates/ directory')
}

/**
 * Per-file scaffold policy (the user's "plugin-managed vs user-owned" split):
 *
 *   - `managed` — the plugin is the SOLE author (the CI net + its helper script).
 *     Auto-overwritten when it drifts from the shipped template so a template fix
 *     reaches already-scaffolded repos on the next `factory scaffold`. Git is the
 *     safety net; customizing a managed file is unsupported by contract.
 *   - `seed` — scaffold-once, then PROJECT-OWNED. Copied verbatim only when ABSENT
 *     (a load-safe baseline); once present the project owns it. An existing file is
 *     reported `present` and never read, compared, overwritten, or re-flagged
 *     (Decision 15) — so a repo that has grown its own richer config (e.g. an
 *     eslint.config.mjs that imports plugins) is recognized as current, not stale.
 */
type TemplatePolicy = 'managed' | 'seed'

interface TemplateEntry {
    /** Path relative to BOTH `templatesDir` and `targetRoot` (forward-slashed). */
    readonly rel: string
    readonly policy: TemplatePolicy
    /** Only scaffold this file when the target is a Node package (has package.json). */
    readonly nodeOnly?: boolean
}

/**
 * The committed per-repo artifacts the factory consumes. The CI workflow and its
 * cost-aware shard helper are MANAGED (plugin-authored, auto-updated); the gate
 * configs are SEED (a starting point the project then owns + tunes).
 */
/** The managed CI workflow — also the gateEnv injection target (the only transformed file). */
const QUALITY_GATE_REL = '.github/workflows/quality-gate.yml'

const TEMPLATE_MANIFEST: readonly TemplateEntry[] = [
    {rel: QUALITY_GATE_REL, policy: 'managed'},
    {rel: '.github/scripts/shard-mutation-scope.mjs', policy: 'managed'},
    {rel: '.stryker.config.json', policy: 'seed', nodeOnly: true},
    {rel: '.dependency-cruiser.cjs', policy: 'seed', nodeOnly: true},
    {rel: 'eslint.config.mjs', policy: 'seed', nodeOnly: true},
    // e2e (Decision 39) — seed only; @playwright/test must already be a devDependency
    // (scaffold never installs packages) and the config's webServer.command is a TODO
    // the project fills in. testDir here MUST match `e2e.testDir` (default "e2e").
    {rel: 'playwright.config.ts', policy: 'seed', nodeOnly: true},
    {rel: 'e2e/example.spec.ts', policy: 'seed', nodeOnly: true},
]

/** Mutable file buckets a scaffold run accumulates, surfaced in the report. */
interface FileLists {
    readonly created: string[]
    readonly present: string[]
    readonly updated: string[]
}

/**
 * Apply one {@link TemplateEntry}, landing it in exactly one bucket:
 *   - absent           → write the rendered template in (`created`)
 *   - present + seed    → project-owned: report `present`, never read/compare/overwrite
 *   - present + managed → refresh on drift (`updated`), else `present`
 *
 * `transform` renders the template text before write/compare (managed files only,
 * e.g. injecting the resolved gateEnv into `quality-gate.yml`). Because drift is
 * measured against the RENDERED template, an injected managed file stays
 * byte-identical across re-runs — no spurious `updated` flag.
 */
async function applyTemplate(
    entry: TemplateEntry,
    templatesDir: string,
    targetRoot: string,
    lists: FileLists,
    transform?: (text: string) => string
): Promise<void> {
    const segs = entry.rel.split('/')
    const src = join(templatesDir, ...segs)
    const dest = join(targetRoot, ...segs)
    if (!existsSync(src)) {
        log.warn(`template missing, skipping: ${src}`)
        return
    }
    const render = async (): Promise<string> => {
        const text = await readFile(src, 'utf8')
        return transform ? transform(text) : text
    }
    if (!existsSync(dest)) {
        await mkdir(dirname(dest), {recursive: true})
        await writeFile(dest, await render(), 'utf8')
        lists.created.push(entry.rel)
        return
    }
    // A present SEED file is PROJECT-OWNED: never read, compared, overwritten, or
    // re-flagged. A repo's grown-up config (e.g. an eslint.config.mjs that imports
    // plugins) is recognized as current, not stale (Decision 15).
    //
    // KNOWN, DELIBERATE LIMITATION: this also means a NEW baseline rule added to a
    // shipped SEED template (e.g. an extra .dependency-cruiser.cjs boundary rule) does
    // NOT propagate to already-scaffolded repos — their copy is left as-is. That is the
    // price of the project-ownership guarantee; there is intentionally no SEED
    // drift-detection (it would reintroduce the clobber risk this tier prevents). A repo
    // opts into a refreshed baseline by deleting the file and re-scaffolding. Machinery
    // that must stay in lockstep belongs in the MANAGED tier. See Decision 15.
    if (entry.policy === 'seed') {
        lists.present.push(entry.rel)
        return
    }
    // MANAGED: the plugin is the sole author — refresh the target when it drifts from
    // the rendered template so a template fix propagates to already-scaffolded repos.
    // Git is the safety net.
    const [rendered, destText] = await Promise.all([render(), readFile(dest, 'utf8')])
    if (rendered === destText) {
        lists.present.push(entry.rel)
        return
    }
    await writeFile(dest, rendered, 'utf8')
    lists.updated.push(entry.rel)
}

/** Append any missing {@link GITIGNORE_ENTRIES} to the target `.gitignore`. */
async function ensureGitignore(root: string, lists: FileLists): Promise<void> {
    const path = join(root, '.gitignore')
    const rel = relative(root, path)
    if (!existsSync(path)) {
        await writeFile(path, GITIGNORE_ENTRIES.join('\n') + '\n', 'utf8')
        lists.created.push(rel)
        return
    }
    const current = await readFile(path, 'utf8')
    const missing = GITIGNORE_ENTRIES.filter((e) => !current.split('\n').includes(e))
    if (missing.length === 0) {
        lists.present.push(rel)
        return
    }
    const sep = current.endsWith('\n') ? '' : '\n'
    await writeFile(path, current + sep + missing.join('\n') + '\n', 'utf8')
    lists.present.push(rel)
}

/**
 * The scaffold CORE: copy templates, probe/refuse/provision protection on
 * `develop` (the integration base). Pure of `process`/argv — driven by
 * {@link ScaffoldOptions} so units exercise it with fakes + temp dirs. Throws
 * loud on a protection shortfall when `--provision` is not set.
 *
 * Per-run staging branches (`staging-<run-id>`) are minted at `run create` —
 * scaffold no longer creates or protects a shared `staging` branch.
 */
export async function runScaffold(opts: ScaffoldOptions): Promise<ScaffoldReport> {
    const lists: FileLists = {created: [], present: [], updated: []}

    // 0. Auto-detect CI build env → gap-fill quality.gateEnv, BEFORE the managed
    //    quality-gate.yml template (step 1) overwrites the repo's own workflow. This
    //    captures the repo author's build env into the durable config overlay while
    //    that file is still the author's; gap-fill never clobbers an operator value.
    const gateEnv = await applyGateEnvDetection(opts.targetRoot, {dataDir: opts.dataDir})
    if (gateEnv.written.length > 0) {
        log.info(`detected ${gateEnv.written.length} CI build-env var(s) → quality.gateEnv`)
    }
    // Surface unparseable workflows LOUDLY and independent of the report's JSON shape —
    // a silently-swallowed parse failure here means the managed template overwrites the
    // repo's workflow with zero signal (the CRITICAL silent-failure this guards).
    if (gateEnv.warnings.length > 0) {
        log.warn(
            `CI build-env detection skipped ${gateEnv.warnings.length} unparseable workflow file(s): ` +
                gateEnv.warnings.map((w) => w.workflow).join(', ')
        )
    }

    // 1+2. Committed template artifacts (Δ Z). MANAGED files (the CI net + its shard
    //       helper) auto-update on drift; SEED gate configs are copy-once + user-owned.
    //       The `nodeOnly` SEED configs apply only to a Node-package target. The managed
    //       quality-gate.yml is rendered with the resolved gateEnv injected into its
    //       build step (single source of truth for the local gate AND this repo's CI).
    const isNodePackage = existsSync(join(opts.targetRoot, 'package.json'))
    for (const entry of TEMPLATE_MANIFEST) {
        if (entry.nodeOnly === true && !isNodePackage) {
            continue
        }
        const transform =
            entry.rel === QUALITY_GATE_REL
                ? (text: string) => injectGateEnvIntoWorkflow(text, gateEnv.gateEnv)
                : undefined
        await applyTemplate(entry, opts.templatesDir, opts.targetRoot, lists, transform)
    }
    // Surface auto-updated plugin-managed files (e.g. the CI workflow refreshed in a
    // previously-scaffolded repo) — these are the propagation path, worth a loud line.
    if (lists.updated.length > 0) {
        log.info(`auto-updated ${lists.updated.length} plugin-managed file(s): ${lists.updated.join(', ')}`)
    }

    // 2b. The GATE CONTRACT (S7, Decision 46): resolve the stack + write
    //     `.factory/gates.json` (seed-like — an existing VALID contract is
    //     project-owned; an invalid one refuses). AFTER templates so the freshly
    //     seeded eslint config participates in the npm lint resolution. Throws
    //     loud below the floor (test/type/build equivalents uncontractable).
    const gates = await ensureGateContract({
        targetRoot: opts.targetRoot,
        securityCommand: opts.config.quality.securityCommand,
        waiveMutation: opts.waiveMutation === true,
        waiveCoverage: opts.waiveCoverage === true,
    })
    if (gates.status === 'created') {
        lists.created.push(GATE_CONTRACT_REL)
        log.info(
            `wrote ${GATE_CONTRACT_REL} (stack: ${gates.stack}) — COMMIT it; 'factory run' requires the contract tracked`
        )
    } else {
        lists.present.push(GATE_CONTRACT_REL)
    }
    // S8 PBT advisory (never blocks, never installs): fast-check unlocks the
    // test-writer's property-based tests.
    if (await recommendFastCheck(opts.targetRoot)) {
        log.info(
            "property-based testing: fast-check not installed — consider 'npm i -D fast-check' " +
                'so the test-writer can write property tests (advisory only)'
        )
    }

    // 3. .gitignore guard (factory state must never be committed).
    await ensureGitignore(opts.targetRoot, lists)

    // 3b. E1 (F-perm): emit / idempotently merge the target-repo
    //     `.claude/settings.json` (factory allow-list + baked data-dir rules +
    //     worktree.baseRef:"head"; NO statusLine — that belongs to E2's
    //     merged-settings). Non-destructive: a user's existing settings keys (incl.
    //     their own statusLine) are kept, and any stale `${CLAUDE_PLUGIN_DATA}`
    //     placeholder rules from an older scaffold are migrated to the baked form.
    const settings = await ensureTargetSettings({
        targetRoot: opts.targetRoot,
        dataDirRules: opts.dataDirRules,
    })
    // Surface the .claude/settings.json path in the file lists for transparency.
    const settingsRel = relative(opts.targetRoot, settings.path)
    if (settings.created) {
        lists.created.push(settingsRel)
    } else {
        lists.present.push(settingsRel)
    }

    // 4. branch protection on develop: probe → refuse-if-missing, OR provision when opted in.
    //    develop is a PRECONDITION — scaffold does not create it (a missing develop
    //    makes the probe fail loud, which is acceptable).
    const branch = opts.config.git.baseBranch
    const required = opts.config.git.requiredStatusChecks
    let state = await probeProtection({
        ghClient: opts.ghClient,
        owner: opts.owner,
        repo: opts.repo,
        branch,
    })
    let provisioned = false
    if (opts.provision) {
        state = await provisionProtection({
            ghClient: opts.ghClient,
            owner: opts.owner,
            repo: opts.repo,
            branch,
            requiredChecks: required,
            provision: true,
        })
        provisioned = true
    }
    // Assert the gate in both paths: a post-provision re-probe must satisfy it too.
    requireProtectionOrRefuse(state, required, branch)

    return {
        repo: `${opts.owner}/${opts.repo}`,
        files_created: lists.created,
        files_present: lists.present,
        files_updated: lists.updated,
        protection: {
            enabled: state.enabled,
            strict_up_to_date: state.strictUpToDate,
            required_status_checks: state.requiredStatusChecks,
            provisioned,
        },
        settings: {created: settings.created, changed: settings.changed},
        stack: gates.stack,
        gates_contract: gates.status,
        // Include the detection report whenever a key was detected OR any anomaly
        // surfaced (a parse warning, an expression-ref/secret/key drop) — so a malformed
        // workflow's `warnings` are never silently swallowed. `written`/`conflicts` each
        // imply a detected key, so they're subsumed by the detected-key check. Omitted
        // only for a clean brand-new repo (no workflows, nothing to report).
        ...(Object.keys(gateEnv.detected).length > 0 ||
        gateEnv.warnings.length > 0 ||
        gateEnv.skippedExpressionRefs.length > 0 ||
        gateEnv.droppedSecrets.length > 0 ||
        gateEnv.droppedKeys.length > 0
            ? {gateEnv}
            : {}),
    }
}

/**
 * Test seam for {@link run}'s repo resolution: inject the git seam + cwd so the
 * auto-derive path (Prompt G) is exercised with a fake remote. Production passes
 * the real {@link DefaultGitClient} + `process.cwd()`.
 */
export interface ScaffoldRepoOverrides {
    readonly gitClient?: GitClient
    readonly cwd?: string
}

/**
 * Resolve the scaffold target's `<owner>/<name>` — `--repo` is OPTIONAL (Prompt G),
 * auto-derived from the origin remote when omitted; an explicit value that
 * disagrees with the remote fails loud.
 */
export async function resolveScaffoldRepo(
    args: ReturnType<typeof parseArgs>,
    overrides: ScaffoldRepoOverrides = {}
): Promise<{owner: string; repo: string}> {
    const slug = await resolveRepo({
        explicit: optionalString(args.flag('repo')),
        cwd: overrides.cwd ?? process.cwd(),
        gitClient: overrides.gitClient ?? new DefaultGitClient(),
    })
    return splitRepoSlug(slug)
}

async function run(argv: string[]): Promise<ExitCode> {
    const args = parseArgs(argv, {booleans: ['provision']})
    if (args.flag('help') === true) {
        emitLine(HELP)
        return EXIT.OK
    }

    // --waive takes exactly "mutation" or "coverage" (the scaffold-waivable gates).
    const waived = args.all('waive').map(String)
    for (const w of waived) {
        if (w !== 'mutation' && w !== 'coverage') {
            throw new UsageError(`--waive accepts only 'mutation' or 'coverage' (got '${w}')`)
        }
    }

    const {owner, repo} = await resolveScaffoldRepo(args)
    // Resolve the CANONICAL data dir ONCE at the command boundary (corrects the
    // foreign-plugin env-var leak). resolveDataDir() throwing on an unresolvable dir
    // is the correct loud failure — there is deliberately no placeholder fallback.
    const dataDir = resolveDataDir()
    const report = await runScaffold({
        targetRoot: process.cwd(),
        templatesDir: resolveTemplatesDir(),
        owner,
        repo,
        config: loadConfig(),
        ghClient: new DefaultGhClient(),
        // Bake the resolved data dir into the target permission rules, and thread it
        // into CI build-env detection's config write.
        dataDirRules: buildTargetDataDirRules({dataDir, home: homedir()}),
        dataDir,
        provision: args.flag('provision') === true,
        waiveMutation: waived.includes('mutation'),
        waiveCoverage: waived.includes('coverage'),
    })
    emitJson(report)
    return EXIT.OK
}

export const scaffoldCommand: Subcommand = {
    describe: 'Prepare a repo (templates + develop branch protection) for the pipeline',
    run: withUsageGuard('scaffold', run),
}
