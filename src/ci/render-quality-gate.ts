/**
 * Render the managed quality-gate.yml from the target repo's resolved gate
 * contract (Decision 53) — ONE source of truth for the local GateRunner and CI.
 * Pure, deterministic text render over the shipped template: the `# factory:setup`
 * / `# factory:gates` / `# factory:mutation-setup` markers become per-stack steps,
 * and the `# factory:mutation-begin/end` region collapses to a vacuous-green
 * "Mutation Testing" aggregator when mutation is waived (the required-check
 * context stays universal across factory repos). The `# factory:gate-env` marker
 * is EMITTED (not consumed) here — `injectGateEnvIntoWorkflow` fills it downstream.
 *
 * npm-stack only (covers both npm and pnpm package managers). deno/custom throw
 * loud — scaffold skips the CI net for them with a per-stack reason.
 */
import type {GateContract, GateContractEntry} from '../verifier/deterministic/gate-contract.js'
import type {GateId} from '../verifier/deterministic/gate-id.js'

export interface RenderQualityGateOpts {
    /** The repo's resolved gate contract (`.factory/gates.json`). */
    readonly contract: GateContract
    /** Lockfile-detected package manager (pnpm-lock.yaml → pnpm, else npm). */
    readonly packageManager: 'pnpm' | 'npm'
    /** Whether a lockfile exists (npm without one → `npm install`, no cache). */
    readonly hasLockfile: boolean
    /** The target package.json `scripts` map — read ONLY for the optional deps:validate step, never for gate commands. */
    readonly scripts: Readonly<Record<string, string>>
    /** Whether `next` is a dependency (adds the typegen step). */
    readonly hasNextDep: boolean
}

/** Pinned action refs shared by the generated setup blocks (keep in sync with the template). */
const SETUP_NODE = 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0'
const PNPM_SETUP = 'pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093 # v6.0.8'

/** Replace the single line whose trimmed content is `marker` with `block` lines at the marker's indent. */
function replaceMarker(lines: string[], marker: string, block: readonly string[]): string[] {
    const idx = lines.findIndex((l) => l.trim() === marker)
    if (idx === -1) {
        throw new Error(`renderQualityGate: template is missing the '${marker}' marker`)
    }
    const indentMatch = /^[ \t]*/.exec(lines[idx] ?? '')
    const indent = indentMatch ? indentMatch[0] : ''
    return [...lines.slice(0, idx), ...block.map((b) => (b === '' ? '' : indent + b)), ...lines.slice(idx + 1)]
}

/**
 * The command a contracted COMMAND gate runs in CI: override > GateRunner built-in —
 * exactly the two tiers the local GateRunner resolves, so CI and the local gate run
 * the SAME command. There is deliberately NO package.json-script tier: the local
 * gate never consults scripts, so rendering them here was the one channel where CI
 * could diverge (a repo's `test` script running something the merge gate never ran).
 * The sanctioned custom-command path is the `.factory/gates.json` override
 * (Decision 46), honored by both consumers. `builtin` arrives package-manager-ready
 * (build's built-in IS `npm run build`/`pnpm run build` — the local DefaultBuildTool
 * runs the script by name).
 */
function gateCommand(entry: GateContractEntry, builtin: string): string {
    if (entry.contracted && entry.command !== undefined) {
        return entry.command
    }
    return builtin
}

/** One `- run:` step (or the uncontracted audit comment) for a quality-job gate. */
function gateStep(id: GateId, opts: RenderQualityGateOpts, builtin: string): readonly string[] {
    const entry = opts.contract.gates[id]
    if (!entry.contracted) {
        return [`# ${id} gate uncontracted: ${entry.reason}`]
    }
    return [`- run: ${gateCommand(entry, builtin)}`]
}

/** The checkout-adjacent package-manager setup steps for the quality job. */
function setupBlock(opts: RenderQualityGateOpts): readonly string[] {
    if (opts.packageManager === 'pnpm') {
        return [
            `- uses: ${PNPM_SETUP}`,
            `- uses: ${SETUP_NODE}`,
            '  with:',
            '      node-version: 20',
            '      cache: pnpm',
            '- run: pnpm install --frozen-lockfile',
        ]
    }
    if (opts.hasLockfile) {
        return [`- uses: ${SETUP_NODE}`, '  with:', '      node-version: 20', '      cache: npm', '- run: npm ci']
    }
    return [`- uses: ${SETUP_NODE}`, '  with:', '      node-version: 20', '- run: npm install --no-audit --no-fund']
}

/** The gate steps for the quality job: typegen?, type, lint, test, build(+gate-env), deps:validate?, audit. */
function gatesBlock(opts: RenderQualityGateOpts): readonly string[] {
    const pm = opts.packageManager
    const lines: string[] = []
    if (opts.hasNextDep) {
        lines.push(
            '- name: Generate Next.js type declarations',
            `  run: ${pm === 'pnpm' ? 'pnpm next typegen' : 'npx next typegen'}`
        )
    }
    const run = pm === 'pnpm' ? 'pnpm exec' : 'npx'
    lines.push(...gateStep('type', opts, `${run} tsc --noEmit`))
    lines.push(...gateStep('lint', opts, `${run} eslint .`))
    lines.push(...gateStep('test', opts, `${run} vitest run`))
    lines.push(...gateStep('build', opts, `${pm} run build`))
    lines.push(
        "  # Build-time env for CI parity with the factory's local merge gate. Managed by",
        '  # the factory: `factory scaffold` replaces the marker below with a real `env:`',
        '  # block rendered from quality.gateEnv (set via `factory configure`). Placeholders',
        '  # only — real secrets stay in ${{ secrets.* }}. An empty gateEnv leaves the marker.',
        '  # factory:gate-env'
    )
    if (opts.scripts['deps:validate'] !== undefined) {
        lines.push(`- run: ${pm === 'pnpm' ? 'pnpm deps:validate' : 'npm run deps:validate'}`)
    }
    if (pm === 'pnpm') {
        lines.push(
            '- name: pnpm audit (non-blocking; pnpm legacy endpoint 410, Snyk covers vulns)',
            '  run: pnpm audit --audit-level=high',
            '  continue-on-error: true'
        )
    } else {
        lines.push(
            '- name: npm audit (non-blocking)',
            '  run: npm audit --audit-level=high',
            '  continue-on-error: true'
        )
    }
    return lines
}

/** The conditioned package-manager setup steps for the mutation shard job. */
function mutationSetupBlock(opts: RenderQualityGateOpts): readonly string[] {
    const cond = "if: steps.slice.outputs.slice != ''"
    if (opts.packageManager === 'pnpm') {
        return [
            `- uses: ${PNPM_SETUP}`,
            `  ${cond}`,
            `- uses: ${SETUP_NODE}`,
            `  ${cond}`,
            '  with:',
            '      node-version: 20',
            '      cache: pnpm',
            `- ${cond}`,
            '  run: pnpm install --frozen-lockfile',
        ]
    }
    if (opts.hasLockfile) {
        return [
            `- uses: ${SETUP_NODE}`,
            `  ${cond}`,
            '  with:',
            '      node-version: 20',
            '      cache: npm',
            `- ${cond}`,
            '  run: npm ci',
        ]
    }
    return [
        `- uses: ${SETUP_NODE}`,
        `  ${cond}`,
        '  with:',
        '      node-version: 20',
        `- ${cond}`,
        '  run: npm install --no-audit --no-fund',
    ]
}

/** The vacuous-green aggregator that replaces the mutation region when the gate is waived. */
function waivedMutationBlock(reason: string): readonly string[] {
    const quoted = reason.replace(/'/g, "''")
    return [
        `# Mutation testing is waived in this repo's gate contract: ${reason}.`,
        '# The aggregator job is kept so the required status check "Mutation Testing"',
        '# stays a universal context across factory repos; it reports green without',
        '# running any mutants.',
        'mutation-testing:',
        '  name: Mutation Testing',
        '  runs-on: ubuntu-latest',
        '  needs: quality',
        '  steps:',
        `    - run: echo 'Mutation testing waived (gate contract): ${quoted}'`,
    ]
}

/** Collapse the `# factory:mutation-begin` … `# factory:mutation-end` region. */
function renderMutationRegion(lines: string[], opts: RenderQualityGateOpts): string[] {
    const begin = lines.findIndex((l) => l.trim() === '# factory:mutation-begin')
    const end = lines.findIndex((l) => l.trim() === '# factory:mutation-end')
    if (begin === -1 || end === -1 || end < begin) {
        throw new Error("renderQualityGate: template is missing the '# factory:mutation-begin/end' region")
    }
    const mutation = opts.contract.gates.mutation
    if (!mutation.contracted) {
        const indentMatch = /^[ \t]*/.exec(lines[begin] ?? '')
        const indent = indentMatch ? indentMatch[0] : ''
        const block = waivedMutationBlock(mutation.reason).map((b) => (b === '' ? '' : indent + b))
        return [...lines.slice(0, begin), ...block, ...lines.slice(end + 1)]
    }
    // Contracted: keep the region, drop the marker lines, fill the shard setup.
    let kept = [...lines.slice(0, begin), ...lines.slice(begin + 1, end), ...lines.slice(end + 1)]
    kept = replaceMarker(kept, '# factory:mutation-setup', mutationSetupBlock(opts))
    if (opts.packageManager === 'npm') {
        kept = kept.map((l) => l.replace('pnpm exec stryker run \\', 'npx stryker run \\'))
    }
    return kept
}

/**
 * Render the quality-gate workflow template for one repo. Throws loud for a
 * non-npm contract stack — the caller (scaffold) skips the CI net for those
 * with a per-stack reason instead of writing a broken workflow.
 */
export function renderQualityGate(template: string, opts: RenderQualityGateOpts): string {
    if (opts.contract.stack !== 'npm') {
        throw new Error(
            `renderQualityGate: stack '${opts.contract.stack}' is not supported — the CI quality gate ` +
                'renders for npm-stack repos only (deno/custom repos rely on the local GateRunner)'
        )
    }
    let lines = template.split('\n')
    lines = replaceMarker(lines, '# factory:setup', setupBlock(opts))
    lines = replaceMarker(lines, '# factory:gates', gatesBlock(opts))
    lines = renderMutationRegion(lines, opts)
    return lines.join('\n')
}
