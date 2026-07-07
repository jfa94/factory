import {describe, it, expect} from 'vitest'
import {runSessionStart, FACTORY_HARNESS_REMINDER} from './session-start.js'
import {EXIT} from '../shared/exit-codes.js'

describe('runSessionStart', () => {
    it('emits SessionStart additionalContext with an Iron Law + the skill pointer, returns OK', () => {
        let written = ''
        const code = runSessionStart([], {emit: (s) => (written += s)})

        expect(code).toBe(EXIT.OK)
        const payload = JSON.parse(written) as {
            hookSpecificOutput: {hookEventName: string; additionalContext: string}
        }
        expect(payload.hookSpecificOutput.hookEventName).toBe('SessionStart')
        expect(payload.hookSpecificOutput.additionalContext).toBe(FACTORY_HARNESS_REMINDER)
        expect(payload.hookSpecificOutput.additionalContext).toContain('Fail loud')
        expect(payload.hookSpecificOutput.additionalContext).toContain('skills/pipeline-runner/SKILL.md')
    })
})
