import {describe, it, expect} from 'vitest'
import {resolvePluginRoot} from '../../config/index.js'
import {composeCrossVendorPrompt} from './cross-vendor-prompt.js'

describe('composeCrossVendorPrompt', () => {
    it('composes the quality-reviewer charter + review-protocol contract + a worktree/base pointer', async () => {
        const prompt = await composeCrossVendorPrompt({
            pluginRoot: resolvePluginRoot(),
            baseRef: 'origin/staging-run-1',
            worktree: '/data/runs/run-1/tasks/t1',
        })
        expect(prompt).toContain('RawReview')
        expect(prompt).toContain('git -C /data/runs/run-1/tasks/t1 diff origin/staging-run-1')
    })
})
