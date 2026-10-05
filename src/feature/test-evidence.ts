import type {ProcResult} from '../verifier/deterministic/tools.js'
import {isTestPath} from '../verifier/deterministic/scope.js'
import {stripVTControlCharacters} from 'node:util'
import {dirname, isAbsolute, relative, resolve} from 'node:path'

/** A test suite that failed to load: the unresolved import and the absolute path of the file importing it. */
export interface LoadFailure {
    specifier: string
    importer: string
}

export interface TestEvidence {
    executed: number
    assertionFailure: boolean
    /** Present only when every failed suite of a run with zero executed tests is a recognized load failure. */
    loadFailures?: LoadFailure[]
}

// The forms observed for a suite that cannot load (direct or transitive import): Vitest 3 names
// an absolute importer; Vitest 4 (Vite 8) one relative to the Vitest root. Fixtures: test-evidence.test.ts.
const LOAD_FAILURE =
    /^Error: (?:Cannot find (?:module|package) '([^']+)' imported from '([^']+)'|Failed to resolve import "([^"]+)" from "([^"]+)"\. Does the file exist\?)$/gm

function loadFailures(output: string): LoadFailure[] | undefined {
    const failed = /^\s*Test Files\s+(\d+) failed/m.exec(output)?.[1]
    const rows = [...output.matchAll(LOAD_FAILURE)].map((m) => ({
        specifier: m[1] ?? m[3] ?? '',
        importer: m[2] ?? m[4] ?? '',
    }))
    return rows.length > 0 && rows.length === Number(failed) ? rows : undefined
}

/** Recognize executed tests, never an exit code alone. Unknown reporters fail closed. */
export function testEvidence(proc: ProcResult): TestEvidence {
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
        if (proc.code !== 0) {
            // A failed run that reports no tests (a suite that could not load) is a producer
            // failure to repair, not an unverifiable pass; only a "success" without evidence is.
            const failures = loadFailures(output)
            return {executed: 0, assertionFailure: false, ...(failures ? {loadFailures: failures} : {})}
        }
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

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

/**
 * The declared non-test task file a relative load failure names, resolved against the importing
 * file inside `root` (any listed extension, or `/index.<ext>`), or undefined when it names none.
 */
export function declaredModule(failure: LoadFailure, root: string, files: readonly string[]): string | undefined {
    if (!/^\.\.?\//.test(failure.specifier) || failure.importer === '') {
        return undefined
    }
    // ponytail: a relative importer is taken as relative to `root`; wrong if Vitest's root is a subdirectory.
    const importer = resolve(root, failure.importer)
    const target = relative(root, resolve(dirname(importer), failure.specifier))
    if (target === '' || target.startsWith('..') || isAbsolute(target)) {
        return undefined
    }
    const stem = target.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, '')
    const candidates = new Set([target, ...EXTENSIONS.flatMap((ext) => [`${stem}${ext}`, `${target}/index${ext}`])])
    return files.map((file) => file.replace(/^\.\//, '')).find((file) => candidates.has(file) && !isTestPath(file))
}

/** RED by load failure: every failure names a declared non-test task file that is absent at the task base. */
export async function missingDeclaredModules(
    failures: readonly LoadFailure[],
    root: string,
    files: readonly string[],
    existsAtBase: (path: string) => Promise<boolean>
): Promise<boolean> {
    for (const failure of failures) {
        const path = declaredModule(failure, root, files)
        if (path === undefined || (await existsAtBase(path))) {
            return false
        }
    }
    return failures.length > 0
}
