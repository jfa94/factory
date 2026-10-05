import {describe, expect, it, vi} from 'vitest'
import {defaultConfig} from '../config/schema.js'
import type {ProtectionApiResult} from '../git/gh-client.js'
import {GATE_IDS} from '../verifier/deterministic/gate-id.js'
import {assertFeatureEnvironment} from './preflight.js'

const config = defaultConfig()
const contract = JSON.stringify({
    version: 1,
    stack: 'npm',
    gates: Object.fromEntries(GATE_IDS.map((id) => [id, {contracted: false, reason: 'fixture'}])),
})
const spec = (raw: string | undefined) => ({contracts: raw === undefined ? {} : {'.factory/gates.json': raw}})
const protectedBranch: ProtectionApiResult = {
    enabled: true,
    strictUpToDate: true,
    hasMergeQueue: false,
    requiredStatusChecks: [...config.git.developRequiredStatusChecks],
}

describe('feature creation environment', () => {
    it('reads stable strict protection without a mutation capability', async () => {
        const repoProtection = vi.fn().mockResolvedValue(protectedBranch)
        await assertFeatureEnvironment(spec(contract), 'owner/repo', config, 'develop', {repoProtection})
        expect(repoProtection).toHaveBeenCalledExactlyOnceWith('owner', 'repo', 'develop')
    })
    it.each([undefined, '{}', 'invalid JSON'])(
        'rejects a missing or invalid committed gate contract: %s',
        async (raw) => {
            const repoProtection = vi.fn()
            await expect(
                assertFeatureEnvironment(spec(raw), 'owner/repo', config, 'develop', {repoProtection})
            ).rejects.toThrow()
            expect(repoProtection).not.toHaveBeenCalled()
        }
    )
    it.each([{enabled: false}, {strictUpToDate: false}, {requiredStatusChecks: []}])(
        'refuses insufficient protection: %j',
        async (change) => {
            await expect(
                assertFeatureEnvironment(spec(contract), 'owner/repo', config, 'develop', {
                    repoProtection: vi.fn().mockResolvedValue({...protectedBranch, ...change}),
                })
            ).rejects.toThrow('insufficient')
        }
    )
    it('surfaces an unavailable protection API', async () => {
        await expect(
            assertFeatureEnvironment(spec(contract), 'owner/repo', config, 'develop', {
                repoProtection: vi.fn().mockRejectedValue(new Error('GitHub unavailable')),
            })
        ).rejects.toThrow('GitHub unavailable')
    })
})
