import {afterEach, describe, expect, it, vi} from 'vitest'
import {runFeatureGuard, runFeatureStop, decideFeatureGuard} from './feature-guards.js'
import {FeatureStore} from '../feature/store.js'
import {readHookInput} from './hook-io.js'
import type * as HookIo from './hook-io.js'

vi.mock('./hook-io.js', async (original) => ({
    ...(await original<typeof HookIo>()),
    readHookInput: vi.fn(),
}))
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
})
describe('v2 hook entry points', () => {
    it('allows a tool when no feature owns the session', async () => {
        vi.stubEnv('CLAUDE_PLUGIN_DATA', '/tmp/feature-hook-unused')
        vi.spyOn(FeatureStore.prototype, 'list').mockResolvedValue([])
        vi.mocked(readHookInput).mockResolvedValue({tool_name: 'Edit', cwd: '/unrelated'})
        expect(await runFeatureGuard()).toBe(0)
        expect(decideFeatureGuard(null, []).action).toBe('allow')
    })
    it('fails closed and surfaces unreadable feature state', async () => {
        vi.stubEnv('CLAUDE_PLUGIN_DATA', '/tmp/feature-hook-unused')
        vi.spyOn(FeatureStore.prototype, 'list').mockRejectedValue(new Error('corrupt feature state'))
        vi.mocked(readHookInput).mockResolvedValue({tool_name: 'Edit'})
        const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
        expect(await runFeatureGuard()).toBe(1)
        expect(output.mock.calls.flat().join('')).toContain('corrupt feature state')
    })
    it('fails closed on malformed hook input', async () => {
        vi.mocked(readHookInput).mockRejectedValue(new Error('malformed input'))
        vi.spyOn(process.stdout, 'write').mockReturnValue(true)
        expect(await runFeatureGuard()).toBe(1)
    })
    it('never advances state on Stop with an absent or unrelated session', async () => {
        vi.stubEnv('CLAUDE_PLUGIN_DATA', '/tmp/feature-hook-unused')
        const list = vi.spyOn(FeatureStore.prototype, 'list').mockResolvedValue([])
        vi.mocked(readHookInput).mockResolvedValue(null)
        expect(await runFeatureStop()).toBe(0)
        expect(list).not.toHaveBeenCalled()
        vi.mocked(readHookInput).mockResolvedValue({session_id: 'unrelated'})
        expect(await runFeatureStop()).toBe(0)
        expect(list).toHaveBeenCalledOnce()
    })
    it('reports a Stop state error without mutating the run', async () => {
        vi.stubEnv('CLAUDE_PLUGIN_DATA', '/tmp/feature-hook-unused')
        vi.mocked(readHookInput).mockResolvedValue({session_id: 'owner'})
        vi.spyOn(FeatureStore.prototype, 'list').mockRejectedValue(new Error('state unavailable'))
        const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
        expect(await runFeatureStop()).toBe(1)
        expect(output.mock.calls.flat().join('')).toContain('state unavailable')
    })
})
