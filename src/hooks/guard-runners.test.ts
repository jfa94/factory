/**
 * The stdin run wrappers of the three PreToolUse guards: malformed input fails
 * closed with a deny on stdout, a benign input exits OK, a deny exits ERROR.
 */
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {runBranchProtection} from './branch-protection.js'
import {runSecretGuard} from './secret-guard.js'
import {runWriteProtection} from './write-protection.js'
import {captureStream, type CapturedStream} from '../cli/test-helpers.js'
import {EXIT} from '../shared/exit-codes.js'

const raw = (value: unknown) => () => Promise.resolve(JSON.stringify(value))
const malformed = () => Promise.resolve('{not json')

let out: CapturedStream
beforeEach(() => {
    out = captureStream(process.stdout)
})
afterEach(() => {
    out.restore()
})

describe.each([
    ['branch-protection', runBranchProtection],
    ['secret-guard', runSecretGuard],
    ['write-protection', runWriteProtection],
] as const)('%s run wrapper', (name, runGuard) => {
    it('fails closed on malformed stdin', async () => {
        await expect(runGuard([], {readRaw: malformed})).resolves.toBe(EXIT.ERROR)
        expect(out.read()).toContain('malformed_hook_input')
        expect(out.read()).toContain(`${name}: unparseable hook input`)
    })

    it('allows a non-matching tool silently', async () => {
        await expect(runGuard([], {readRaw: raw({tool_name: 'Read', tool_input: {}})})).resolves.toBe(EXIT.OK)
        expect(out.read()).toBe('')
    })
})

describe('run wrapper deny path', () => {
    it('emits the permission decision and exits ERROR', async () => {
        const code = await runBranchProtection([], {
            readRaw: raw({tool_name: 'Bash', tool_input: {command: 'git push origin main'}}),
            resolveCurrentBranch: () => Promise.resolve('feature'),
            autonomousMode: false,
        })
        expect(code).toBe(EXIT.ERROR)
        expect(out.read()).toContain('"permissionDecision":"deny"')
    })
})
