/**
 * Create-time preconditions for `factory run create`, extracted from the CLI
 * subcommand so `run.ts` stays a thin wrapper. Both are eager, fail-LOUD checks run
 * BEFORE a run is born, when the fix is still one command:
 *   - {@link assertE2ePrereqs}   — the repo carries the static Playwright prereqs (--e2e, Decision 40 D2).
 *   - {@link assertGateContract} — a present, valid, git-TRACKED `.factory/gates.json` (S7, Decision 46).
 */
import {access, readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {UsageError} from '../shared/usage-error.js'
import {loadGateContract, GATE_CONTRACT_REL} from '../verifier/deterministic/index.js'
import type {GitClient} from '../git/index.js'

/**
 * Create-time eager check (Decision 40 D2): `--e2e` fails create unless the repo
 * already carries the three STATIC Playwright prerequisites. Deep validation (boot,
 * auth, coverage) belongs to the e2e-assessment phase — this only catches "e2e was
 * never set up here" before a run is born, when the fix is still one command.
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
    try {
        await access(join(cwd, 'playwright.config.ts'))
    } catch {
        missing.push('playwright.config.ts')
    }
    if (missing.length > 0) {
        throw new UsageError(
            `run create: --e2e requires a Playwright-ready repo; missing: ${missing.join(', ')}. ` +
                'Run `factory scaffold` to seed playwright.config.ts + e2e/, and install @playwright/test.'
        )
    }
}

/**
 * Create-time gate-contract precondition (S7, Decision 46): a run may only be
 * born in a repo whose `.factory/gates.json` contract is present, valid, AND
 * git-tracked. Tracked matters — an uncommitted contract never reaches the
 * task worktrees, so every gate sweep would run the legacy pre-contract path
 * despite the file existing at the root. Resume paths skip this: in-flight
 * runs created pre-contract are covered by the GateRunner legacy warn.
 */
export async function assertGateContract(cwd: string, gitClient: GitClient): Promise<void> {
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
}
