import {readFileSync} from 'node:fs'
import fc from 'fast-check'
import {describe, expect, it} from 'vitest'
import {isTestPath} from '../verifier/deterministic/scope.js'
import {declaredModule, missingDeclaredModules, testEvidence, type LoadFailure} from './test-evidence.js'
const proc = (stdout: string, code = 0) => ({stdout, stderr: '', code, truncated: false})
// Captured from this repo's Vitest 3.2.6 in /private/tmp/vlf.N7av (decision 2).
const captured = (name: string) => ({
    stdout: readFileSync(new URL(`fixtures/${name}.stdout.txt`, import.meta.url), 'utf8'),
    stderr: readFileSync(new URL(`fixtures/${name}.stderr.txt`, import.meta.url), 'utf8'),
    code: 1,
    truncated: false,
})
const root = '/private/tmp/vlf.N7av'
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
    it('reads a failed run that executed no tests as zero evidence, not an unverifiable pass', () => {
        expect(testEvidence(proc('{"numPassedTests":0,"numFailedTests":0,"numFailedTestSuites":1}', 1))).toEqual({
            executed: 0,
            assertionFailure: false,
        })
        expect(
            testEvidence(proc('Test Files 1 failed (1)\nTests no tests\nError: Failed to resolve import', 1))
        ).toEqual({executed: 0, assertionFailure: false})
    })
    it('recognizes colored reporter summaries without counting skipped tests', () => {
        expect(
            testEvidence(proc('\u001b[1m Tests \u001b[32m2 passed\u001b[39m | 3 skipped (5)\u001b[0m')).executed
        ).toBe(2)
        expect(
            testEvidence(proc('\u001b[32mℹ pass 2\u001b[39m\n\u001b[31mℹ fail 1\u001b[39m\nAssertionError', 1))
        ).toEqual({executed: 3, assertionFailure: true})
    })
    it('parses every observed Vitest load failure: static, extensionless, transitive, bare and directory imports', () => {
        expect(testEvidence(captured('vitest-load-failures'))).toEqual({
            executed: 0,
            assertionFailure: false,
            loadFailures: [
                {specifier: './lib/missing.js', importer: `${root}/src/a.test.ts`},
                {specifier: './lib/nothere', importer: `${root}/src/b.test.ts`},
                {specifier: './inner-missing.js', importer: `${root}/src/lib/exists.ts`},
                {specifier: 'not-a-package', importer: `${root}/src/e.test.ts`},
                {specifier: '../src/feature', importer: `${root}/tests/c.test.ts`},
            ],
        })
    })
    it('parses the Vitest 4 form, whose importer is relative to the Vitest root', () => {
        // Captured from asset-generator's Vitest 4.1.10 / Vite 8.1.4 (canary #5).
        expect(testEvidence(captured('vitest4-load-failures'))).toEqual({
            executed: 0,
            assertionFailure: false,
            loadFailures: [
                {specifier: './lib/missing.js', importer: 'src/a.test.ts'},
                {specifier: './lib/nothere', importer: 'src/b.test.ts'},
                {specifier: './inner-missing.js', importer: 'src/lib/exists.ts'},
                {specifier: 'not-a-package', importer: 'src/e.test.ts'},
            ],
        })
    })
    it('reports no load failures when another failed suite is not a recognized load failure', () => {
        expect(testEvidence(captured('vitest-load-and-syntax'))).toEqual({executed: 0, assertionFailure: false})
    })
    it('treats a dynamic import failure inside an executed test as executed, not a load failure', () => {
        expect(testEvidence(captured('vitest-dynamic-import'))).toEqual({executed: 1, assertionFailure: false})
    })
})

describe('declared module resolution (decision 2)', () => {
    const files = ['src/lib/missing.ts', 'src/lib/nothere.tsx', 'src/feature/index.ts', 'src/a.test.ts', './src/c.js']
    const failure = (specifier: string, importer = `${root}/src/a.test.ts`): LoadFailure => ({specifier, importer})
    it.each([
        ['./lib/missing.js', 'src/lib/missing.ts'],
        ['./lib/missing', 'src/lib/missing.ts'],
        ['./lib/nothere', 'src/lib/nothere.tsx'],
        ['./feature', 'src/feature/index.ts'],
        ['./c.js', 'src/c.js'],
    ])('resolves %s to the declared %s', (specifier, path) => {
        expect(declaredModule(failure(specifier), root, files)).toBe(path)
    })
    it('resolves a root-relative importer (Vitest 4) like an absolute one', () => {
        expect(declaredModule(failure('./lib/missing.js', 'src/a.test.ts'), root, files)).toBe('src/lib/missing.ts')
        expect(declaredModule(failure('./x.js', '../outside/a.test.ts'), root, ['../outside/x.js'])).toBeUndefined()
    })
    it('resolves against the importing file, including a parent directory', () => {
        expect(declaredModule(failure('../src/feature', `${root}/tests/c.test.ts`), root, files)).toBe(
            'src/feature/index.ts'
        )
    })
    it.each([
        ['bare package', failure('not-a-package')],
        ['undeclared file', failure('./lib/other.js')],
        ['declared test file', failure('./a.test.ts')],
        ['escapes the root', failure('../../outside.js')],
        ['the root itself', failure('../', `${root}/src/a.test.ts`)],
        ['unlisted extension', failure('./lib/missing.json')],
    ])('refuses a %s', (_name, row) => {
        expect(declaredModule(row, root, files)).toBeUndefined()
    })
    it('qualifies only when every failure is a declared module absent at the task base', async () => {
        const absent = () => Promise.resolve(false)
        expect(await missingDeclaredModules([failure('./lib/missing.js')], root, files, absent)).toBe(true)
        expect(await missingDeclaredModules([], root, files, absent)).toBe(false)
        expect(
            await missingDeclaredModules([failure('./lib/missing.js'), failure('not-a-package')], root, files, absent)
        ).toBe(false)
        expect(
            await missingDeclaredModules([failure('./lib/missing.js')], root, files, () => Promise.resolve(true))
        ).toBe(false)
    })
    it('never qualifies a specifier that does not resolve to a declared, absent, non-test file', async () => {
        const segment = fc.stringMatching(/^[a-z.]{1,6}$/)
        await fc.assert(
            fc.asyncProperty(
                fc.array(segment, {minLength: 1, maxLength: 4}),
                fc.constantFrom('', './', '../', '/'),
                fc.array(fc.array(segment, {minLength: 1, maxLength: 3}), {maxLength: 4}),
                fc.boolean(),
                async (parts, prefix, declared, existsAtBase) => {
                    const row = failure(prefix + parts.join('/'))
                    const list = declared.map((p) => `src/${p.join('/')}`)
                    const path = declaredModule(row, root, list)
                    const red = await missingDeclaredModules([row], root, list, () => Promise.resolve(existsAtBase))
                    if (path === undefined || existsAtBase) {
                        expect(red).toBe(false)
                    } else {
                        expect(red).toBe(true)
                        expect(list).toContain(path)
                        expect(isTestPath(path)).toBe(false)
                        expect(row.specifier).toMatch(/^\.\.?\//)
                    }
                }
            )
        )
    })
})
