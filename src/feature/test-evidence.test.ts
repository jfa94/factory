import {describe, expect, it} from 'vitest'
import {testEvidence} from './test-evidence.js'
const proc = (stdout: string, code = 0) => ({stdout, stderr: '', code, truncated: false})
describe('test execution evidence', () => {
    it('counts actual passed and failed tests, excluding skips', () => {
        expect(testEvidence(proc('Tests 2 passed | 1 skipped (3)')).executed).toBe(2)
        expect(testEvidence(proc('# pass 2\n# fail 1\n# skipped 4\nAssertionError', 1))).toEqual({
            executed: 3,
            assertionFailure: true,
        })
        expect(testEvidence(proc('{"numPassedTests":2,"numFailedTests":0}')).executed).toBe(2)
    })
    it.each(['', 'Everything passed', 'Tests 3 skipped (3)', '# pass 0\n# fail 0'])(
        'refuses vacuous success: %s',
        (output) => {
            expect(() => testEvidence(proc(output))).toThrow('executed-test evidence')
        }
    )
    it('does not call a compiler or module-loading error a meaningful red assertion', () => {
        expect(testEvidence(proc('# pass 0\n# fail 1\nSyntaxError: unexpected token', 1)).assertionFailure).toBe(false)
    })
    it('recognizes colored reporter summaries without counting skipped tests', () => {
        expect(
            testEvidence(proc('\u001b[1m Tests \u001b[32m2 passed\u001b[39m | 3 skipped (5)\u001b[0m')).executed
        ).toBe(2)
        expect(
            testEvidence(proc('\u001b[32mℹ pass 2\u001b[39m\n\u001b[31mℹ fail 1\u001b[39m\nAssertionError', 1))
        ).toEqual({executed: 3, assertionFailure: true})
    })
})
