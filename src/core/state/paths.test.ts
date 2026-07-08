import {describe, expect, it} from 'vitest'
import {join} from 'node:path'
import {
    repoKey,
    specDir,
    runDir,
    runStatePath,
    currentRepoRoot,
    currentRepoLinkPath,
    docsFactoryDir,
    worktreesRoot,
} from './paths.js'

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

describe('two-store layout', () => {
    const data = '/tmp/data'
    it('spec dir is keyed by (repo, spec-id), not run id (Δ X)', () => {
        expect(specDir(data, 'acme/widgets', '42-checkout')).toBe(join(data, 'specs', 'acme-widgets', '42-checkout'))
    })
    it('the SAME (repo, spec-id) resolves to the SAME path across runs', () => {
        const a = specDir(data, 'acme/widgets', '42-checkout')
        const b = specDir(data, 'acme/widgets', '42-checkout')
        expect(a).toBe(b)
    })
    it('run store is keyed by run id', () => {
        expect(runDir(data, 'run-1')).toBe(join(data, 'runs', 'run-1'))
        expect(runStatePath(data, 'run-1')).toBe(join(data, 'runs', 'run-1', 'state.json'))
    })
    it('worktrees root is a sibling of runs/ and specs/ (per-task worktrees live here)', () => {
        expect(worktreesRoot(data)).toBe(join(data, 'worktrees'))
    })
    it('per-repo current tree is a sibling of runs/ (so listRuns is untouched, L2.7)', () => {
        expect(currentRepoRoot(data)).toBe(join(data, 'current'))
        // NOT under runs/ — that would pollute the runDir enumeration.
        expect(currentRepoRoot(data)).not.toBe(join(data, 'runs', 'current'))
    })
    it('per-repo current pointer records the repo id to one safe segment', () => {
        expect(currentRepoLinkPath(data, 'acme/widgets')).toBe(join(data, 'current', 'acme-widgets'))
    })
    it('per-repo current pointer rejects a path-traversal repo id', () => {
        expect(() => currentRepoLinkPath(data, '..')).toThrow(/traversal/)
    })
    it('rejects an unsafe run id / spec id', () => {
        expect(() => runDir(data, '../escape')).toThrow()
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
        // Unlike specDir(dataDir, repo, specId), the in-repo copy lives in the target
        // repo itself, so there is no repo-key segment.
        expect(docsFactoryDir('/repo/docs', '1-x')).toBe(join('/repo/docs', 'factory', '1-x'))
    })
    it('validates the spec-id charset (no traversal into / out of docs/)', () => {
        expect(() => docsFactoryDir('/repo/docs', '../escape')).toThrow()
    })
})
