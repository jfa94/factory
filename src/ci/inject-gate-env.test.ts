/**
 * Tests for injecting the resolved gateEnv INTO the managed quality-gate.yml. A pure
 * string render: the `# factory:gate-env` marker becomes a real `env:` block at the
 * marker's indentation; an empty map leaves the marker; a missing marker is a no-op
 * (so re-injecting an already-injected file is stable).
 */
import {describe, it, expect} from 'vitest'
import {injectGateEnvIntoWorkflow} from './inject-gate-env.js'

const TEMPLATE = `jobs:
  quality:
    steps:
      - run: pnpm build
        # factory:gate-env
      - run: pnpm deps:validate
`

describe('injectGateEnvIntoWorkflow', () => {
    it('replaces the marker with an env: block at the marker indent, keys sorted, values quoted', () => {
        const out = injectGateEnvIntoWorkflow(TEMPLATE, {
            NEXT_PUBLIC_URL: 'http://localhost:54321',
            API_KEY: 'ci-placeholder',
        })
        expect(out).toContain('        env:\n')
        expect(out).toContain('          API_KEY: "ci-placeholder"\n')
        expect(out).toContain('          NEXT_PUBLIC_URL: "http://localhost:54321"\n')
        expect(out.indexOf('API_KEY')).toBeLessThan(out.indexOf('NEXT_PUBLIC_URL')) // sorted
        expect(out).not.toContain('# factory:gate-env')
    })

    it('leaves the marker untouched for an empty gateEnv', () => {
        expect(injectGateEnvIntoWorkflow(TEMPLATE, {})).toBe(TEMPLATE)
    })

    it('is a no-op (idempotent) when there is no marker — e.g. an already-injected file', () => {
        const once = injectGateEnvIntoWorkflow(TEMPLATE, {A: '1'})
        expect(injectGateEnvIntoWorkflow(once, {A: '1'})).toBe(once)
    })
})
