import type {ProcResult} from '../verifier/deterministic/tools.js'
import {stripVTControlCharacters} from 'node:util'

/** Recognize executed tests, never an exit code alone. Unknown reporters fail closed. */
export function testEvidence(proc: ProcResult): {executed: number; assertionFailure: boolean} {
    if (proc.truncated) {
        throw new Error('test evidence was truncated')
    }
    const output = stripVTControlCharacters(`${proc.stdout}\n${proc.stderr}`)
    let executed = 0
    // Jest/Vitest JSON reporters.
    try {
        const value: unknown = JSON.parse(proc.stdout)
        if (
            typeof value === 'object' &&
            value !== null &&
            'numPassedTests' in value &&
            'numFailedTests' in value &&
            typeof value.numPassedTests === 'number' &&
            typeof value.numFailedTests === 'number'
        ) {
            executed = value.numPassedTests + value.numFailedTests
        }
    } catch {
        /* Human-readable reporters below. */
    }
    // Node's TAP/spec summary. Tests marked skipped are excluded by pass + fail.
    const passed = /^(?:#|ℹ) pass (\d+)\s*$/m.exec(output)
    const failed = /^(?:#|ℹ) fail (\d+)\s*$/m.exec(output)
    if (passed && failed) {
        executed = Number(passed[1]) + Number(failed[1])
    }
    // Vitest's summary counts tests separately from files and skips.
    const summary = /^\s*Tests\s+(.+)$/m.exec(output)?.[1]
    if (summary !== undefined) {
        executed = [...summary.matchAll(/(\d+)\s+(?:passed|failed)/g)].reduce((sum, match) => sum + Number(match[1]), 0)
    }
    if (!Number.isInteger(executed) || executed <= 0) {
        throw new Error(
            'test command provided no recognized executed-test evidence; configure a TAP, Node, Jest JSON or Vitest reporter'
        )
    }
    return {
        executed,
        assertionFailure:
            proc.code !== 0 && /AssertionError|ERR_ASSERTION|expected .+ to |toEqual|toBe\(/i.test(output),
    }
}
