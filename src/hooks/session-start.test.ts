import {describe, it, expect, vi} from 'vitest'
import {runSessionStart} from './session-start.js'
import {EXIT} from '../shared/exit-codes.js'
import {featureRunFixture} from '../feature/test-fixtures.js'
import type {FeatureRun} from '../feature/schema.js'

async function reminder(cwd: string, runs: FeatureRun[]): Promise<{code: number; written: string}> {
    let written = ''
    const code = await runSessionStart([], {
        cwd,
        runs: () => Promise.resolve(runs),
        pluginRoot: '/plugins/factory',
        emit: (s) => (written += s),
    })
    return {code, written}
}

function context(written: string): string {
    const payload = JSON.parse(written) as {hookSpecificOutput: {hookEventName: string; additionalContext: string}}
    expect(payload.hookSpecificOutput.hookEventName).toBe('SessionStart')
    return payload.hookSpecificOutput.additionalContext
}

describe('runSessionStart', () => {
    it('emits nothing outside a run', async () => {
        expect(await reminder('/elsewhere', [featureRunFixture()])).toEqual({code: EXIT.OK, written: ''})
    })

    it('emits nothing inside a terminal run', async () => {
        expect(await reminder('/repo', [featureRunFixture({status: 'completed'})])).toEqual({
            code: EXIT.OK,
            written: '',
        })
    })

    it('names the run, its status, the absolute skill path and the next command inside its worktree', async () => {
        const runs = [
            featureRunFixture({run_id: 'other', root: '/other', worktree: '/other/.claude/worktrees/feature-other'}),
            featureRunFixture(),
        ]
        const {code, written} = await reminder('/repo/.claude/worktrees/feature-run/src', runs)
        expect(code).toBe(EXIT.OK)
        const text = context(written)
        expect(text).toContain('Factory run run is running.')
        expect(text).toContain('Next: factory next-action --run run --driver <session>')
        expect(text).toContain('/plugins/factory/skills/pipeline-runner/SKILL.md')
        expect(text).not.toContain('Factory run other')
    })

    it('gives a parked run its resume command from the repository root', async () => {
        const text = context((await reminder('/repo', [featureRunFixture({status: 'parked'})])).written)
        expect(text).toContain('Factory run run is parked. Next: factory resume --run run')
    })

    it('reports an unreadable run store as a hook error', async () => {
        const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
        const emit = vi.fn()
        const code = await runSessionStart([], {cwd: '/repo', runs: () => Promise.reject(new Error('boom')), emit})
        expect(code).toBe(EXIT.ERROR)
        expect(emit).not.toHaveBeenCalled()
        expect(stderr).toHaveBeenCalledWith('Factory session reminder failed: boom\n')
        stderr.mockRestore()
    })
})
