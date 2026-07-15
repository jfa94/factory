import {describe, expect, it, vi} from 'vitest'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {EXIT} from '../shared/exit-codes.js'
import type {RunState} from '../types/index.js'
import {StateManager} from '../core/state/manager.js'
import {readMetrics} from '../scoring/telemetry.js'
import {handleNotification, runNotification} from './notification.js'
import {parseHookInput} from './hook-io.js'
import type {OwnerScopedRunOptions} from './hook-context.js'

const activeRun = {
    dataDir: '/data',
    run: {run_id: 'run-1'} as RunState,
}

function input(fields: Record<string, unknown>) {
    return parseHookInput(JSON.stringify(fields))
}

describe('Notification permission telemetry', () => {
    it('appends a metric for a permission message on an active run', async () => {
        const emit = vi.fn(() => Promise.resolve({ts: 't', run_id: 'run-1', event: 'permission.requested'}))
        const resolutions: OwnerScopedRunOptions[] = []
        const loadRun = (opts: OwnerScopedRunOptions) => {
            resolutions.push(opts)
            return Promise.resolve(activeRun)
        }

        await handleNotification(
            input({message: 'Claude needs your permission to use Bash', session_id: 's1', cwd: '/repo'}),
            {loadRun, emit}
        )

        const resolution = resolutions[0]
        expect(resolution?.cwd).toBe('/repo')
        expect(resolution?.env?.CLAUDE_CODE_SESSION_ID).toBe('s1')
        expect(emit).toHaveBeenCalledWith('/data', 'run-1', 'permission.requested', {
            message: 'Claude needs your permission to use Bash',
            session_id: 's1',
        })
    })

    it('lands permission.requested in the active run metrics stream', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'factory-notification-'))
        try {
            const manager = new StateManager({dataDir})
            const run = await manager.create({
                run_id: 'run-real',
                owner_session: 's1',
                staging_branch: 'staging-run-real',
                spec: {repo: 'acme/widgets', spec_id: '1-x', issue_number: 1},
            })

            await handleNotification(input({message: 'Permission required', session_id: 's1'}), {
                loadRun: () => Promise.resolve({dataDir, run}),
            })

            await expect(readMetrics(dataDir, 'run-real')).resolves.toMatchObject([
                {
                    run_id: 'run-real',
                    event: 'permission.requested',
                    data: {message: 'Permission required', session_id: 's1'},
                },
            ])
        } finally {
            await rm(dataDir, {recursive: true, force: true})
        }
    })

    it('ignores idle and other non-permission notifications without resolving a run', async () => {
        const loadRun = vi.fn(() => Promise.resolve(activeRun))
        const emit = vi.fn()

        await handleNotification(input({message: 'Claude is waiting for your input'}), {loadRun, emit})

        expect(loadRun).not.toHaveBeenCalled()
        expect(emit).not.toHaveBeenCalled()
    })

    it('does not write when no active run exists', async () => {
        const emit = vi.fn()

        await handleNotification(input({message: 'Permission required'}), {
            loadRun: () => Promise.resolve(null),
            emit,
        })

        expect(emit).not.toHaveBeenCalled()
    })

    it('returns OK on malformed input', async () => {
        expect(await runNotification([], {readRaw: () => Promise.resolve('{bad')})).toBe(EXIT.OK)
    })

    it('returns OK when active-run resolution fails', async () => {
        const code = await runNotification([], {
            readRaw: () => Promise.resolve(JSON.stringify({message: 'permission required'})),
            loadRun: () => Promise.reject(new Error('store unavailable')),
        })
        expect(code).toBe(EXIT.OK)
    })
})
