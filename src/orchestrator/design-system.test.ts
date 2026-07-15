import {afterEach, describe, expect, it} from 'vitest'
import fc from 'fast-check'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {findDesignSystemDocs, isFrontendPath} from './design-system.js'

const roots: string[] = []

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, {recursive: true, force: true})))
})

describe('isFrontendPath', () => {
    it.each([
        'src/Button.tsx',
        'src/view.jsx',
        'components/Button.ts',
        'src/pages/home.ts',
        'app/dashboard/page.ts',
        'styles/theme.scss',
        'src/widget.vue',
    ])('recognises %s', (path) => {
        expect(isFrontendPath(path)).toBe(true)
    })

    it.each(['src/server.ts', 'db/schema.sql', 'scripts/build.mjs', 'component-model/model.ts'])(
        'rejects %s',
        (path) => {
            expect(isFrontendPath(path)).toBe(false)
        }
    )

    it('recognises every declared frontend extension', () => {
        fc.assert(
            fc.property(fc.constantFrom('tsx', 'jsx', 'vue', 'svelte', 'css', 'scss', 'less'), (extension) => {
                expect(isFrontendPath(`src/arbitrary.${extension}`)).toBe(true)
            })
        )
    })
})

describe('findDesignSystemDocs', () => {
    async function root(): Promise<string> {
        const value = await mkdtemp(join(tmpdir(), 'factory-design-system-'))
        roots.push(value)
        return value
    }

    it('finds matching docs recursively and returns repo-relative sorted paths', async () => {
        const repo = await root()
        await mkdir(join(repo, 'docs', 'product'), {recursive: true})
        await writeFile(join(repo, 'docs', 'style-guide.md'), '# Style')
        await writeFile(join(repo, 'docs', 'product', 'design_tokens.mdx'), '# Tokens')

        await expect(findDesignSystemDocs(repo)).resolves.toEqual([
            'docs/product/design_tokens.mdx',
            'docs/style-guide.md',
        ])
    })

    it('returns empty for a miss or a missing docs directory', async () => {
        const repo = await root()
        await mkdir(join(repo, 'docs'))
        await writeFile(join(repo, 'docs', 'architecture.md'), '# Architecture')
        await expect(findDesignSystemDocs(repo)).resolves.toEqual([])
        await expect(findDesignSystemDocs(await root())).resolves.toEqual([])
    })
})
