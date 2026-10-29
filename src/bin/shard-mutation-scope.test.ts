/**
 * Build-staleness guard: the checked-in scaffold template
 * `templates/.github/scripts/shard-mutation-scope.mjs` is GENERATED from
 * `src/bin/shard-mutation-scope.ts` by scripts/build.mjs. This test re-bundles in
 * memory and asserts byte-equality with the committed artifact, so any drift
 * between the tested TS source and the shipped template fails CI (you forgot to
 * re-run `npm run build`).
 */
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {build, type BuildOptions} from 'esbuild'
import {describe, expect, it} from 'vitest'

import {diffScope, fullScope, isMutablePath, loadExcluded, parseDiffToRanges} from './shard-mutation-scope.js'

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..')

// build.mjs is plain JS (run by node directly, never compiled) — import it
// dynamically with an explicit shape rather than a static untyped import.
async function loadBuildModule(): Promise<{
    SHARD_TEMPLATE: {entry: string; out: string}
    shardTemplateBuildOptions: () => BuildOptions
}> {
    // @ts-expect-error build.mjs is plain JS run by node directly — no .d.ts exists.
    return (await import('../../scripts/build.mjs')) as never
}

describe('shard-mutation-scope template', () => {
    it('checked-in template matches a fresh esbuild of the source', async () => {
        const {SHARD_TEMPLATE, shardTemplateBuildOptions} = await loadBuildModule()
        const result = await build({...shardTemplateBuildOptions(), write: false})
        const generated = result.outputFiles[0]?.text ?? ''
        const committed = readFileSync(resolve(repoRoot, SHARD_TEMPLATE.out), 'utf8')
        expect(generated).toBe(committed)
    })
})

const modified = (path: string, hunks: readonly string[]): string =>
    [
        `diff --git a/${path} b/${path}`,
        'index 1111111..2222222 100644',
        `--- a/${path}`,
        `+++ b/${path}`,
        ...hunks,
    ].join('\n')

const added = (path: string): string =>
    [
        `diff --git a/${path} b/${path}`,
        'new file mode 100644',
        'index 0000000..2222222',
        '--- /dev/null',
        `+++ b/${path}`,
        '@@ -0,0 +1,10 @@',
    ].join('\n')

describe('mutation scope computation', () => {
    it.each(['EACCES', 'EIO', 'ENOENT'])('fails loudly instead of dropping unreadable source (%s)', (code) => {
        const read = (): string => {
            throw Object.assign(new Error(code), {code})
        }
        expect(() => fullScope(['src'], () => 'src/critical.ts\n', read)).toThrow('cannot read src/critical.ts')
        expect(() => diffScope('origin/develop', ['src'], () => added('src/critical.ts'), read)).toThrow(
            'cannot read src/critical.ts'
        )
    })
    it('covers empty diffs, added files, padded hunks, deletion seams, and merged ranges', () => {
        expect(parseDiffToRanges('')).toEqual([])
        expect(parseDiffToRanges(added('src/new.ts'))).toEqual(['src/new.ts'])
        expect(parseDiffToRanges(modified('src/a.ts', ['@@ -10,2 +10,3 @@']))).toEqual(['src/a.ts:8-14'])
        expect(parseDiffToRanges(modified('src/a.ts', ['@@ -20,4 +19,0 @@']))).toEqual(['src/a.ts:17-21'])
        expect(
            parseDiffToRanges(modified('src/a.ts', ['@@ -10,2 +10,2 @@', '@@ -14,1 +14,1 @@', '@@ -18,1 +19,1 @@']))
        ).toEqual(['src/a.ts:8-21'])
    })

    it.each([
        'src/a.test.ts',
        'src/a.spec.ts',
        'src/a.d.ts',
        'src/a.test.tsx',
        'src/a.spec.tsx',
        'src/types/a.ts',
        'src/data/a.ts',
        'src/a/index.ts',
        'src/types.ts',
        'src/event-types.ts',
        'src/app/robots.ts',
        'src/app/sitemap.ts',
    ])('excludes zero-mutant surface %s', (path) => {
        expect(isMutablePath(path)).toBe(false)
        expect(parseDiffToRanges(added(path))).toEqual([])
    })

    it('shares roots, exclusions, and quarantine handling across diff/full modes', () => {
        const read = (path: string): string =>
            path === 'app/quarantined.ts' ? '// Stryker disable all: debt\n' : 'export const ok = true\n'
        const diffGit = (args: readonly string[]): string => {
            expect(args).toEqual([
                'diff',
                '-U0',
                '--diff-filter=AMR',
                'origin/develop...HEAD',
                '--',
                ':(glob)app/**/*.ts',
                ':(glob)app/**/*.tsx',
                ':(glob)utils/**/*.ts',
                ':(glob)utils/**/*.tsx',
            ])
            return [added('app/quarantined.ts'), added('utils/ok.ts')].join('\n')
        }
        expect(diffScope('origin/develop', ['app', 'utils'], diffGit, read)).toEqual(['utils/ok.ts'])

        const fullGit = (args: readonly string[]): string => {
            expect(args).toEqual([
                'ls-files',
                '--',
                ':(glob)app/**/*.ts',
                ':(glob)app/**/*.tsx',
                ':(glob)utils/**/*.ts',
                ':(glob)utils/**/*.tsx',
            ])
            return 'app/quarantined.ts\napp/types.ts\nutils/ok.ts\n'
        }
        expect(fullScope(['app', 'utils'], fullGit, read)).toEqual(['utils/ok.ts'])
    })

    it('mutates .tsx components alongside .ts', () => {
        expect(isMutablePath('src/components/Card.tsx')).toBe(true)
        expect(parseDiffToRanges(added('src/components/Card.tsx'))).toEqual(['src/components/Card.tsx'])
    })

    it('drops paths listed in .factory/mutation-exclude.json in both modes', () => {
        const read = (): string => 'export const ok = true\n'
        const excluded = new Set(['src/lib/exempt.ts'])
        const diff = [added('src/lib/exempt.ts'), added('src/ok.ts')].join('\n')
        expect(diffScope('origin/develop', ['src'], () => diff, read, excluded)).toEqual(['src/ok.ts'])
        expect(fullScope(['src'], () => 'src/lib/exempt.ts\nsrc/ok.ts\n', read, excluded)).toEqual(['src/ok.ts'])
    })
})

describe('loadExcluded — optional repo exclude list', () => {
    it('is empty when the file is absent', () => {
        const read = (): string => {
            throw Object.assign(new Error('missing'), {code: 'ENOENT'})
        }
        expect(loadExcluded(read)).toEqual(new Set())
    })

    it('reads a JSON array of repo-relative paths', () => {
        const read = (path: string): string => {
            expect(path).toBe('.factory/mutation-exclude.json')
            return '["src/a.tsx", "src/b.ts"]'
        }
        expect(loadExcluded(read)).toEqual(new Set(['src/a.tsx', 'src/b.ts']))
    })

    it.each(['{"a":1}', '[1]', 'not json'])('fails loudly on a malformed file: %s', (text) => {
        expect(() => loadExcluded(() => text)).toThrow('.factory/mutation-exclude.json')
    })

    it.each(['./src/a.ts', ' src/a.ts', 'src/a.ts ', 'src\\a.ts', '/src/a.ts', 'src/../a.ts', 'src/lib/', ''])(
        'fails loudly on a non-canonical entry %j (it would never match a path)',
        (entry) => {
            expect(() => loadExcluded(() => JSON.stringify([entry]))).toThrow(/mutation-exclude\.json.*entry/)
        }
    )

    it('fails loudly when the file exists but cannot be read', () => {
        const read = (): string => {
            throw Object.assign(new Error('denied'), {code: 'EACCES'})
        }
        expect(() => loadExcluded(read)).toThrow('.factory/mutation-exclude.json')
    })
})
