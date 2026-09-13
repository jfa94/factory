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
    it('emits no block on a Stop re-entry (stop_hook_active) even when a staged result awaits', async () => {
        vi.stubEnv('CLAUDE_PLUGIN_DATA', '/tmp/feature-hook-unused')
        vi.mocked(readHookInput).mockResolvedValue({session_id: 'owner', stop_hook_active: true})
        const attempt = {
            id: 'attempt',
            driver: 'owner',
            stage: 'implement' as const,
            base_sha: 'a'.repeat(40),
            head_sha: 'a'.repeat(40),
            spec_digest: 'digest',
            worktree: '/wt',
            roles: ['implementer'],
            issued_at: '2026-09-07T00:00:00Z',
        }
        vi.spyOn(FeatureStore.prototype, 'list').mockResolvedValue([
            {run_id: 'run', owner_session: 'owner', status: 'running', in_flight: attempt} as never,
        ])
        const staged = vi.spyOn(FeatureStore.prototype, 'stagedPresent').mockResolvedValue(['implementer'])
        const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
        vi.spyOn(process.stderr, 'write').mockReturnValue(true)
        expect(await runFeatureStop()).toBe(0)
        expect(output).not.toHaveBeenCalled()
        expect(staged).not.toHaveBeenCalled()
        vi.mocked(readHookInput).mockResolvedValue({session_id: 'owner'})
        expect(await runFeatureStop()).toBe(0)
        expect(output.mock.calls.flat().join('')).toContain('"decision":"block"')
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
