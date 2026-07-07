/**
 * Tests for rendering the managed quality-gate.yml from a repo's resolved gate
 * contract (Decision 53). Pure string render over the shipped template: the
 * `# factory:setup` / `# factory:gates` / `# factory:mutation-*` markers become
 * per-stack steps; mutation waived → vacuous-green "Mutation Testing" aggregator;
 * non-npm stacks refuse loud. Runs against the REAL shipped template so a template
 * restructure that breaks the render contract fails here first.
 */
import {describe, it, expect, beforeAll} from 'vitest'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {renderQualityGate, type RenderQualityGateOpts} from './render-quality-gate.js'
import {injectGateEnvIntoWorkflow} from './inject-gate-env.js'
import {resolveTemplatesDir} from '../cli/subcommands/scaffold.js'
import type {GateContract} from '../verifier/deterministic/gate-contract.js'

let template: string

beforeAll(async () => {
    template = await readFile(join(resolveTemplatesDir(), '.github', 'workflows', 'quality-gate.yml'), 'utf8')
})

/** A full npm contract; override entries per test. */
function npmContract(overrides: Partial<GateContract['gates']> = {}): GateContract {
    return {
        version: 1,
        stack: 'npm',
        gates: {
            test: {contracted: true},
            tdd: {contracted: true},
            coverage: {contracted: true},
            mutation: {contracted: true},
            sast: {contracted: false, reason: 'no quality.securityCommand configured'},
            type: {contracted: true},
            lint: {contracted: true},
            build: {contracted: true},
            ...overrides,
        },
    }
}

const NPM_OPTS: RenderQualityGateOpts = {
    contract: npmContract(),
    packageManager: 'npm',
    hasLockfile: true,
    scripts: {build: 'tsc -p .'},
    hasNextDep: false,
}

const PNPM_OPTS: RenderQualityGateOpts = {
    contract: npmContract(),
    packageManager: 'pnpm',
    hasLockfile: true,
    scripts: {
        typecheck: 'tsc --noEmit',
        lint: 'eslint .',
        test: 'vitest run',
        build: 'next build',
        'deps:validate': 'depcruise src',
    },
    hasNextDep: true,
}

describe('renderQualityGate — npm stack', () => {
    it('renders npm setup: setup-node with npm cache + npm ci; no pnpm anywhere', () => {
        const out = renderQualityGate(template, NPM_OPTS)
        expect(out).toContain('cache: npm')
        expect(out).toContain('- run: npm ci')
        expect(out).not.toContain('pnpm')
    })

    it('renders install without cache + npm install when there is no lockfile', () => {
        const out = renderQualityGate(template, {...NPM_OPTS, hasLockfile: false})
        expect(out).toContain('- run: npm install --no-audit --no-fund')
        expect(out).not.toContain('cache: npm')
        expect(out).not.toContain('npm ci')
    })

    it('renders the GateRunner built-ins (local/CI parity)', () => {
        const out = renderQualityGate(template, NPM_OPTS)
        expect(out).toContain('- run: npx tsc --noEmit')
        expect(out).toContain('- run: npx eslint .')
        expect(out).toContain('- run: npx vitest run')
        expect(out).toContain('- run: npm run build')
    })

    it('IGNORES package.json scripts — the local gate never runs them, so CI must not either', () => {
        const out = renderQualityGate(template, {
            ...NPM_OPTS,
            scripts: {typecheck: 't', lint: 'l', test: 'vitest run', build: 'b'},
        })
        expect(out).toContain('- run: npx tsc --noEmit')
        expect(out).toContain('- run: npx eslint .')
        expect(out).toContain('- run: npx vitest run')
        expect(out).not.toContain('- run: npm run typecheck')
        expect(out).not.toContain('- run: npm test')
    })

    it('a contracted command override wins over built-ins', () => {
        const out = renderQualityGate(template, {
            ...NPM_OPTS,
            contract: npmContract({test: {contracted: true, command: 'vitest run --pool=forks'}}),
            scripts: {test: 'vitest run', build: 'b'},
        })
        expect(out).toContain('- run: vitest run --pool=forks')
        expect(out).not.toContain('- run: npx vitest run')
    })

    it('omits an uncontracted gate, leaving its reason as an audit comment', () => {
        const out = renderQualityGate(template, {
            ...NPM_OPTS,
            contract: npmContract({lint: {contracted: false, reason: 'no eslint config'}}),
        })
        expect(out).not.toContain('npx eslint')
        expect(out).not.toContain('npm run lint')
        expect(out).toContain('# lint gate uncontracted: no eslint config')
    })

    it('adds the Next.js typegen + deps:validate steps only when present', () => {
        const plain = renderQualityGate(template, NPM_OPTS)
        expect(plain).not.toContain('next typegen')
        expect(plain).not.toContain('deps:validate')

        const next = renderQualityGate(template, {
            ...NPM_OPTS,
            hasNextDep: true,
            scripts: {...NPM_OPTS.scripts, 'deps:validate': 'depcruise src'},
        })
        expect(next).toContain('npx next typegen')
        expect(next).toContain('- run: npm run deps:validate')
    })

    it('keeps the mutation jobs (npm-ified) when mutation is contracted', () => {
        const out = renderQualityGate(template, NPM_OPTS)
        expect(out).toContain('mutation-scope:')
        expect(out).toContain('npx stryker run \\')
        expect(out).toContain('name: Mutation Testing')
        expect(out).not.toContain('# factory:mutation-begin')
        expect(out).not.toContain('# factory:mutation-end')
        expect(out).not.toContain('# factory:mutation-setup')
    })

    it('replaces the mutation jobs with a vacuous-green Mutation Testing job when waived', () => {
        const out = renderQualityGate(template, {
            ...NPM_OPTS,
            contract: npmContract({mutation: {contracted: false, reason: 'waived via --waive mutation'}}),
        })
        // The required-check context survives — universal across factory repos.
        expect(out).toContain('name: Mutation Testing')
        expect(out).toContain('waived via --waive mutation')
        // The real mutation machinery is gone.
        expect(out).not.toContain('mutation-scope:')
        expect(out).not.toContain('stryker')
        expect(out).not.toContain('shard-mutation-scope.mjs')
    })
})

describe('renderQualityGate — structure invariants', () => {
    it('emits the three protection contexts and no auto-merge job', () => {
        const out = renderQualityGate(template, NPM_OPTS)
        expect(out).toContain('name: Quality')
        expect(out).toContain('name: Security Scan')
        expect(out).toContain('name: Mutation Testing')
        expect(out).not.toContain('auto-merge')
        expect(out).not.toContain('gh pr merge')
    })

    it('triggers on per-run staging branches and develop', () => {
        const out = renderQualityGate(template, NPM_OPTS)
        expect(out).toMatch(/branches: \[["']staging-\*["'], develop\]/)
    })

    it('leaves no factory markers behind except gate-env (downstream injection point)', () => {
        const out = renderQualityGate(template, NPM_OPTS)
        const markers = out.match(/# factory:[a-z-]+/g) ?? []
        expect(markers).toEqual(['# factory:gate-env'])
    })

    it('composes with injectGateEnvIntoWorkflow (the scaffold pipeline)', () => {
        const out = injectGateEnvIntoWorkflow(renderQualityGate(template, NPM_OPTS), {API_URL: 'http://x'})
        expect(out).toContain('API_URL: "http://x"')
        expect(out).not.toContain('# factory:gate-env')
    })

    it('is deterministic: same inputs render byte-identical output', () => {
        expect(renderQualityGate(template, PNPM_OPTS)).toBe(renderQualityGate(template, PNPM_OPTS))
    })
})

describe('renderQualityGate — pnpm stack', () => {
    it('renders pnpm setup + built-in gate steps (the outsidey shape: scripts ≡ built-ins)', () => {
        const out = renderQualityGate(template, PNPM_OPTS)
        expect(out).toContain('pnpm/action-setup')
        expect(out).toContain('cache: pnpm')
        expect(out).toContain('- run: pnpm install --frozen-lockfile')
        expect(out).toContain('- run: pnpm exec tsc --noEmit')
        expect(out).toContain('- run: pnpm exec eslint .')
        expect(out).toContain('- run: pnpm exec vitest run')
        expect(out).toContain('- run: pnpm run build')
        expect(out).toContain('run: pnpm next typegen')
        expect(out).toContain('- run: pnpm deps:validate')
        expect(out).toContain('pnpm exec stryker run \\')
        expect(out).toContain('pnpm audit --audit-level=high')
    })
})

describe('renderQualityGate — non-npm stacks refuse', () => {
    it('throws loud for a deno contract', () => {
        const deno: GateContract = {
            version: 1,
            stack: 'deno',
            gates: {
                test: {contracted: true, command: 'deno test'},
                tdd: {contracted: true},
                coverage: {contracted: false, reason: 'waived-by-stack'},
                mutation: {contracted: false, reason: 'waived-by-stack'},
                sast: {contracted: false, reason: 'none'},
                type: {contracted: true, command: 'deno check .'},
                lint: {contracted: true, command: 'deno lint'},
                build: {contracted: false, reason: 'waived-by-stack'},
            },
        }
        expect(() => renderQualityGate(template, {...NPM_OPTS, contract: deno})).toThrow(/deno/)
    })
})
