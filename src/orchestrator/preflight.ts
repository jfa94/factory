/**
 * Create-time preconditions for `factory run create`, extracted from the CLI
 * subcommand so `run.ts` stays a thin wrapper. Both are eager, fail-LOUD checks run
 * BEFORE a run is born, when the fix is still one command:
 *   - {@link assertE2ePrereqs}   — the repo carries the static Playwright prereqs (--e2e, Decision 40 D2).
 *   - {@link assertGateContract} — a present, valid, git-TRACKED `.factory/gates.json` (S7, Decision 46).
 */
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {UsageError} from '../shared/usage-error.js'
import {loadGateContract, GATE_CONTRACT_REL, type GateContract} from '../verifier/deterministic/index.js'
import type {GitClient} from '../git/index.js'

/**
 * The Playwright testDirs the TCB write-deny actually covers: rule 3b (tcb.ts)
 * hardcodes the literal `e2e` component per the Δ W invariant, so any other
 * testDir would leave the committed suite write-open to the implementer. Checked
 * against the repo's OWN playwright.config.ts (string-level), never the factory
 * config — reading config to decide what the TCB protects would be exactly the
 * circular trust the TCB exists to refuse.
 */
const TCB_COVERED_TEST_DIRS: readonly string[] = ['e2e', './e2e']

/**
 * Create-time eager check (Decision 40 D2): `--e2e` fails create unless the repo
 * already carries the three STATIC Playwright prerequisites AND its
 * playwright.config.ts declares the TCB-covered testDir (S4 — fail-closed: an
 * absent declaration means Playwright's own default `tests`, outside the TCB
 * write-deny). Deep validation (boot, auth, coverage) belongs to the
 * e2e-assessment phase — this only catches "e2e was never set up here" before a
 * run is born, when the fix is still one command.
 */
export async function assertE2ePrereqs(cwd: string): Promise<void> {
    const missing: string[] = []
    let pkgRaw: string | undefined
    try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads the target repo's own package.json at cwd, an internal derived path
        pkgRaw = await readFile(join(cwd, 'package.json'), 'utf8')
    } catch {
        missing.push('package.json')
    }
    if (pkgRaw !== undefined) {
        let hasDep = false
        let parseable = true
        try {
            const pkg = JSON.parse(pkgRaw) as {
                dependencies?: Record<string, string>
                devDependencies?: Record<string, string>
            }
            hasDep =
                pkg.dependencies?.['@playwright/test'] !== undefined ||
                pkg.devDependencies?.['@playwright/test'] !== undefined
        } catch {
            parseable = false
        }
        // A malformed package.json is its own defect — don't launder it into a
        // "missing @playwright/test" remedy that's wrong even when the dep IS installed.
        if (!parseable) {
            missing.push('a parseable package.json (current file is not valid JSON)')
        } else if (!hasDep) {
            missing.push('@playwright/test (dependencies or devDependencies)')
        }
    }
    let configRaw: string | undefined
    try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads the target repo's own playwright.config.ts at cwd, an internal derived path
        configRaw = await readFile(join(cwd, 'playwright.config.ts'), 'utf8')
    } catch {
        missing.push('playwright.config.ts')
    }
    if (missing.length > 0) {
        throw new UsageError(
            `run create: --e2e requires a Playwright-ready repo; missing: ${missing.join(', ')}. ` +
                'Run `factory scaffold` to seed playwright.config.ts + e2e/, and install @playwright/test.'
        )
    }
    if (configRaw !== undefined) {
        // Every testDir declaration in the file, not just the first — a multi-project
        // config (`projects: [{testDir:'e2e'},{testDir:'tests'}]`) or a decoy comment
        // ahead of the real declaration would otherwise false-ACCEPT via .exec's
        // first-match semantics, letting a real suite live outside the TCB-covered
        // e2e/ path. Ambiguous (>1 declaration) refuses rather than guessing which
        // one governs — the safe default for a check the TCB write-deny relies on.
        const declarations = [...configRaw.matchAll(/testDir\s*:\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
        if (declarations.length > 1) {
            throw new UsageError(
                `run create: --e2e requires playwright.config.ts to declare testDir exactly once (found ${declarations.length}: ${declarations.join(', ')}). ` +
                    'A multi-project or duplicated testDir config is ambiguous — the TCB write-deny protects the ' +
                    "literal e2e/ path only, so a second declaration could route the real suite outside it. Collapse to a single top-level testDir: 'e2e'."
            )
        }
        const declared = declarations[0]
        if (declared === undefined || !TCB_COVERED_TEST_DIRS.includes(declared)) {
            const found = declared === undefined ? 'no testDir declaration' : `testDir '${declared}'`
            throw new UsageError(
                `run create: --e2e requires playwright.config.ts to declare testDir 'e2e' (found ${found}). ` +
                    'The TCB write-deny protects the literal e2e/ path only — a suite anywhere else would be ' +
                    'write-open to the implementer. Run `factory scaffold` to seed the standard config.'
            )
        }
    }
}

/**
 * Create-time gate-contract precondition (S7, Decision 46): a run may only be
 * born in a repo whose `.factory/gates.json` contract is present, valid, AND
 * git-tracked. Tracked matters — an uncommitted contract never reaches the
 * task worktrees, so every gate sweep would throw (the GateRunner refuses to
 * sweep without a contract) despite the file existing at the root. Checked on
 * EVERY intent, resume included — a resumed run's sweeps need the contract too.
 */
export async function assertGateContract(cwd: string, gitClient: GitClient): Promise<GateContract> {
    const load = await loadGateContract(cwd)
    if (load.state === 'absent') {
        throw new UsageError(
            `run create: missing ${GATE_CONTRACT_REL} gate contract — run \`factory scaffold\` and commit the contract.`
        )
    }
    if (load.state === 'invalid') {
        throw new UsageError(
            `run create: invalid ${GATE_CONTRACT_REL} gate contract (${load.error}) — fix it or delete it and re-run \`factory scaffold\`.`
        )
    }
    if (!(await gitClient.isTracked(GATE_CONTRACT_REL, {cwd}))) {
        throw new UsageError(
            `run create: ${GATE_CONTRACT_REL} exists but is not git-tracked — commit it so task worktrees see the contract.`
        )
    }
    return load.contract
}
