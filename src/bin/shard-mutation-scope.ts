/**
 * Compute and stable-hash shard mutation scope for CI.
 *
 *   shard-mutation-scope diff <base-ref> <root...>
 *   shard-mutation-scope full <root...>
 *
 * `diff` emits whole paths for added files and padded Stryker line ranges for
 * modified hunks. `full` emits every tracked mutable file. Both modes share the
 * exact exclusion and quarantine rules, then return the static eight-shard JSON
 * array consumed by the managed workflows. Paths listed in the optional
 * `.factory/mutation-exclude.json` (a JSON array) are dropped in both modes.
 */
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'

import {shardByHash} from '../verifier/deterministic/shard.js'

export const SHARD_COUNT = 8
export const HUNK_PADDING = 2

type ReadText = (path: string) => string
type Git = (args: readonly string[]) => string

const readUtf8: ReadText = (path) => {
    // Paths come from Git output constrained to validated repository roots.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return readFileSync(path, 'utf8')
}

export const EXCLUDE_FILE = '.factory/mutation-exclude.json'

const EXCLUDED = [
    /\.(?:test|spec)\.tsx?$/,
    /\.d\.ts$/,
    /(?:^|\/)types\//,
    /(?:^|\/)data\//,
    /(?:^|\/)index\.ts$/,
    /(?:^|\/)(?:types|[^/]+-types)\.ts$/,
    /(?:^|\/)app\/(?:robots|sitemap)\.ts$/,
] as const

export function isMutablePath(path: string, excluded: ReadonlySet<string> = new Set()): boolean {
    return /\.tsx?$/.test(path) && !excluded.has(path) && EXCLUDED.every((pattern) => !pattern.test(path))
}

/** Read the repo's optional exclude list. Absent = none; unreadable or malformed fails loudly. */
export function loadExcluded(readText: ReadText = readUtf8): Set<string> {
    let text: string
    try {
        text = readText(EXCLUDE_FILE)
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
            return new Set()
        }
        throw new Error(`mutation scope: cannot read ${EXCLUDE_FILE}`, {cause})
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch (cause) {
        throw new Error(`mutation scope: ${EXCLUDE_FILE} is not valid JSON`, {cause})
    }
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
        throw new Error(`mutation scope: ${EXCLUDE_FILE} must be a JSON array of path strings`)
    }
    return new Set(parsed)
}

function isQuarantined(path: string, readText: ReadText): boolean {
    try {
        return readText(path).startsWith('// Stryker disable all')
    } catch (cause) {
        throw new Error(`mutation scope: cannot read ${path}`, {cause})
    }
}

/** Parse `git diff -U0 --diff-filter=AMR` into Stryker mutate patterns. */
export function parseDiffToRanges(diffText: string): string[] {
    const patterns: string[] = []
    let file: string | null = null
    let isNew = false
    let hunks: [number, number][] = []

    const flush = (): void => {
        if (file === null || !isMutablePath(file)) {
            return
        }
        if (isNew) {
            patterns.push(file)
            return
        }
        hunks.sort((a, b) => a[0] - b[0])
        const merged: [number, number][] = []
        for (const [start, end] of hunks) {
            const last = merged.at(-1)
            if (last !== undefined && start <= last[1] + 1) {
                last[1] = Math.max(last[1], end)
            } else {
                merged.push([start, end])
            }
        }
        for (const [start, end] of merged) {
            patterns.push(`${file}:${start}-${end}`)
        }
    }

    for (const line of diffText.split('\n')) {
        const headerMarker = ' b/'
        const headerIndex = line.startsWith('diff --git a/') ? line.lastIndexOf(headerMarker) : -1
        if (headerIndex !== -1) {
            flush()
            file = line.slice(headerIndex + headerMarker.length)
            isNew = false
            hunks = []
            continue
        }
        if (line.startsWith('new file mode')) {
            isNew = true
            continue
        }
        const newSide = line.startsWith('@@ ') ? line.split(' ')[2] : undefined
        if (newSide === undefined || !newSide.startsWith('+') || file === null || isNew) {
            continue
        }
        const [startText, lengthText] = newSide.slice(1).split(',', 2)
        const start = Number.parseInt(startText ?? '1', 10)
        const length = lengthText === undefined ? 1 : Number.parseInt(lengthText, 10)
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length)) {
            continue
        }
        const end = length === 0 ? start + HUNK_PADDING : start + length - 1 + HUNK_PADDING
        hunks.push([Math.max(1, start - HUNK_PADDING), Math.max(1, end)])
    }
    flush()
    return patterns
}

export function filterMutablePatterns(
    patterns: readonly string[],
    readText: ReadText = readUtf8,
    excluded: ReadonlySet<string> = new Set()
): string[] {
    return patterns.filter((pattern) => {
        const path = pattern.split(':', 1)[0] ?? ''
        return isMutablePath(path, excluded) && !isQuarantined(path, readText)
    })
}

export function parseFullFileList(
    fileList: string,
    readText: ReadText = readUtf8,
    excluded: ReadonlySet<string> = new Set()
): string[] {
    return filterMutablePatterns(
        fileList
            .split('\n')
            .map((path) => path.trim())
            .filter(Boolean),
        readText,
        excluded
    )
}

function defaultGit(args: readonly string[]): string {
    return execFileSync('git', [...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
}

function assertRoots(roots: readonly string[]): void {
    if (
        roots.length === 0 ||
        roots.some(
            (root) =>
                root === '' ||
                root.startsWith('/') ||
                root.split('/').some((part) => part === '' || part === '.' || part === '..') ||
                !/^[A-Za-z0-9._/-]+$/.test(root)
        )
    ) {
        throw new Error('mutation roots must be non-empty relative directory paths')
    }
}

function pathspecs(roots: readonly string[]): string[] {
    assertRoots(roots)
    // :(glob) makes ** match zero dirs too, so top-level `<root>/x.ts` is included.
    return roots.flatMap((root) => [`:(glob)${root}/**/*.ts`, `:(glob)${root}/**/*.tsx`])
}

export function diffScope(
    baseRef: string,
    roots: readonly string[],
    git: Git = defaultGit,
    readText?: ReadText,
    excluded?: ReadonlySet<string>
): string[] {
    if (baseRef === '') {
        throw new Error('diff mode requires a base ref')
    }
    const diff = git(['diff', '-U0', '--diff-filter=AMR', `${baseRef}...HEAD`, '--', ...pathspecs(roots)])
    return filterMutablePatterns(parseDiffToRanges(diff), readText, excluded)
}

export function fullScope(
    roots: readonly string[],
    git: Git = defaultGit,
    readText?: ReadText,
    excluded?: ReadonlySet<string>
): string[] {
    const files = git(['ls-files', '--', ...pathspecs(roots)])
    return parseFullFileList(files, readText, excluded)
}

export function shardScope(patterns: readonly string[]): string[] {
    return shardByHash([...patterns], SHARD_COUNT)
}

function usage(): never {
    throw new Error('usage: shard-mutation-scope.mjs diff <base-ref> <root...> | full <root...>')
}

export function run(args: readonly string[]): string[] {
    const [mode, ...rest] = args
    if (mode === 'diff') {
        const [baseRef, ...roots] = rest
        return shardScope(diffScope(baseRef ?? '', roots, defaultGit, readUtf8, loadExcluded()))
    }
    if (mode === 'full') {
        return shardScope(fullScope(rest, defaultGit, readUtf8, loadExcluded()))
    }
    return usage()
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    try {
        process.stdout.write(JSON.stringify(run(process.argv.slice(2))) + '\n')
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = 1
    }
}
