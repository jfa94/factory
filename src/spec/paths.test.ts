import {describe, expect, it} from 'vitest'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {defaultSpecBuildRoot, docsFactoryDir, repoKey, specBuildDir, specDir} from './paths.js'

describe('repoKey — repo id to one safe path segment', () => {
    it('records the owner/name slash to a dash', () => {
        expect(repoKey('acme/widgets')).toBe('acme-widgets')
    })
    it('preserves case and dots (addressability)', () => {
        expect(repoKey('Acme/My.Repo')).toBe('Acme-My.Repo')
    })
    it('collapses and trims separators', () => {
        expect(repoKey('a//b__c')).toBe('a-b__c')
    })
    it('throws on an empty result', () => {
        expect(() => repoKey('///')).toThrow()
    })
    it('rejects a pure-dot key that would traverse out of the store (S1)', () => {
        // No slash to record ⇒ key stays "."/".."; both are path-traversal segments.
        expect(() => repoKey('..')).toThrow(/traversal/)
        expect(() => repoKey('.')).toThrow(/traversal/)
        // And via the spec-store path builder: a "../" repo cannot escape.
        expect(() => specDir('/tmp/data', '..', 'x')).toThrow(/traversal/)
    })
})

describe('spec store layout', () => {
    const data = '/tmp/data'
    it('spec dir is keyed by (repo, spec-id), not run id (Δ X)', () => {
        expect(specDir(data, 'acme/widgets', '42-checkout')).toBe(join(data, 'specs', 'acme-widgets', '42-checkout'))
    })
    it('the SAME (repo, spec-id) resolves to the SAME path across runs', () => {
        const a = specDir(data, 'acme/widgets', '42-checkout')
        const b = specDir(data, 'acme/widgets', '42-checkout')
        expect(a).toBe(b)
    })
    it('rejects an unsafe spec id', () => {
        expect(() => specDir(data, 'acme/x', '../escape')).toThrow()
    })
})

describe('docsFactoryDir — the in-repo reviewable spec copy (F-specloc)', () => {
    it('is keyed by spec-id under <docsRoot>/factory (target-repo, NOT dataDir)', () => {
        // docsRoot is the target repo's docs/ dir (at process.cwd()), distinct from
        // the out-of-repo dataDir spec store.
        expect(docsFactoryDir('/repo/docs', '42-checkout')).toBe(join('/repo/docs', 'factory', '42-checkout'))
    })
    it('is NOT keyed by repo (the repo IS the checkout that owns docs/)', () => {
        expect(docsFactoryDir('/repo/docs', '1-x')).toBe(join('/repo/docs', 'factory', '1-x'))
    })
    it('validates the spec-id charset (no traversal into / out of docs/)', () => {
        expect(() => docsFactoryDir('/repo/docs', '../escape')).toThrow()
    })
})

describe('specBuildDir — transient spec-build scratch', () => {
    it('is keyed by (repo, issue) under <root>/spec-build', () => {
        expect(specBuildDir('/tmp/root', 'acme/widgets', 7)).toBe(join('/tmp/root', 'spec-build', 'acme-widgets', '7'))
    })
    it('rejects a non-positive or non-integer issue number', () => {
        expect(() => specBuildDir('/tmp/root', 'acme/widgets', 0)).toThrow(/positive integer/)
        expect(() => specBuildDir('/tmp/root', 'acme/widgets', 1.5)).toThrow(/positive integer/)
    })
    it('defaults to a namespaced OS temp root', () => {
        expect(defaultSpecBuildRoot()).toBe(join(tmpdir(), 'factory-spec-build'))
    })
})
