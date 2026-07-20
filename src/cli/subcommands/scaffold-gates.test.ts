/**
 * Unit tests for scaffold-time gate-contract resolution (S7, Decision 46):
 * stack detection (deno-first), the deno build-task probe (incl. jsonc
 * comment-stripping), and the floor/waiver refusals — against temp dirs, no
 * gh/git fakes needed.
 */
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {detectMutationRoots, detectStack, resolveGateContract, recommendFastCheck} from './scaffold-gates.js'
import {DEFAULT_GATES} from '../../verifier/deterministic/index.js'

let root: string

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'factory-gates-'))
})
afterEach(async () => {
    await rm(root, {recursive: true, force: true})
})

describe('detectStack', () => {
    it('empty dir → custom', () => {
        expect(detectStack(root)).toBe('custom')
    })

    it('package.json → npm', async () => {
        await writeFile(join(root, 'package.json'), '{}', 'utf8')
        expect(detectStack(root)).toBe('npm')
    })

    it('deno.json wins over a coexisting package.json (deno-first)', async () => {
        await writeFile(join(root, 'package.json'), '{}', 'utf8')
        await writeFile(join(root, 'deno.json'), '{}', 'utf8')
        expect(detectStack(root)).toBe('deno')
    })

    it('deno.jsonc alone → deno', async () => {
        await writeFile(join(root, 'deno.jsonc'), '{}', 'utf8')
        expect(detectStack(root)).toBe('deno')
    })

    it('a JS lockfile wins over a coexisting deno.json (node toolchain proof)', async () => {
        // e.g. a pnpm/Next.js repo whose deno.json only scopes a Supabase Edge
        // Function subdirectory — the root deno.json is not the repo's toolchain.
        await writeFile(join(root, 'package.json'), '{}', 'utf8')
        await writeFile(join(root, 'pnpm-lock.yaml'), '', 'utf8')
        await writeFile(join(root, 'deno.json'), '{"workspace":["supabase/functions/x"]}', 'utf8')
        expect(detectStack(root)).toBe('npm')
    })
})

describe('resolveGateContract — deno build-task probe', () => {
    it('a build task contracts `deno task build`', async () => {
        await writeFile(join(root, 'deno.json'), JSON.stringify({tasks: {build: 'deno run -A build.ts'}}), 'utf8')
        const c = await resolveGateContract({
            targetRoot: root,
            waiveMutation: false,
            waiveCoverage: false,
        })
        expect(c.gates.build).toEqual({contracted: true, command: 'deno task build'})
    })

    it('no build task → waived-by-stack (deno check covers compilation)', async () => {
        await writeFile(join(root, 'deno.json'), JSON.stringify({tasks: {dev: 'x'}}), 'utf8')
        const c = await resolveGateContract({
            targetRoot: root,
            waiveMutation: false,
            waiveCoverage: false,
        })
        expect(c.gates.build.contracted).toBe(false)
        if (!c.gates.build.contracted) {
            expect(c.gates.build.reason).toMatch(/waived-by-stack.*deno check/)
        }
    })

    it('deno.jsonc: comments are stripped for the probe, https:// values survive', async () => {
        await writeFile(
            join(root, 'deno.jsonc'),
            `{
  // the build entrypoint
  /* block comment */
  "tasks": { "build": "deno run -A build.ts" },
  "imports": { "std/": "https://deno.land/std/" }
}`,
            'utf8'
        )
        const c = await resolveGateContract({
            targetRoot: root,
            waiveMutation: false,
            waiveCoverage: false,
        })
        expect(c.gates.build).toEqual({contracted: true, command: 'deno task build'})
    })

    it('an unparseable deno.json fails LOUD (never silently waives build)', async () => {
        await writeFile(join(root, 'deno.json'), '{ tasks: ', 'utf8')
        await expect(
            resolveGateContract({targetRoot: root, waiveMutation: false, waiveCoverage: false})
        ).rejects.toThrow(/not parseable/)
    })
})

/** Floor-satisfying npm fixture (vitest + tsconfig + build script) + extra deps. */
async function npmFixture(deps: Record<string, string> = {}): Promise<void> {
    await writeFile(
        join(root, 'package.json'),
        JSON.stringify({scripts: {build: 'tsc'}, devDependencies: {vitest: '1', ...deps}}),
        'utf8'
    )
    await writeFile(join(root, 'tsconfig.json'), '{}', 'utf8')
}

describe('resolveGateContract — npm coverage (S8 loud-provision)', () => {
    const opts = (waiveCoverage: boolean) => ({targetRoot: root, waiveMutation: true, waiveCoverage}) as const

    it('@vitest/coverage-v8 present → contracted', async () => {
        await npmFixture({'@vitest/coverage-v8': '1'})
        const c = await resolveGateContract(opts(false))
        expect(c.gates.coverage).toEqual({contracted: true})
    })

    it('@vitest/coverage-istanbul present → contracted', async () => {
        await npmFixture({'@vitest/coverage-istanbul': '1'})
        const c = await resolveGateContract(opts(false))
        expect(c.gates.coverage).toEqual({contracted: true})
    })

    it('no provider + --waive coverage → recorded waiver', async () => {
        await npmFixture()
        const c = await resolveGateContract(opts(true))
        expect(c.gates.coverage).toEqual({contracted: false, reason: 'waived via --waive coverage'})
    })

    it('no provider, no waiver → refuses naming install-or-waive', async () => {
        await npmFixture()
        await expect(resolveGateContract(opts(false))).rejects.toThrow(
            /coverage gate.*@vitest\/coverage-v8.*--waive coverage/s
        )
    })
})

describe('recommendFastCheck', () => {
    it('npm without fast-check → true', async () => {
        await npmFixture()
        expect(await recommendFastCheck(root)).toBe(true)
    })

    it('npm with fast-check → false', async () => {
        await npmFixture({'fast-check': '3'})
        expect(await recommendFastCheck(root)).toBe(false)
    })

    it('non-npm stacks → false', async () => {
        expect(await recommendFastCheck(root)).toBe(false) // custom
        await writeFile(join(root, 'deno.json'), '{}', 'utf8')
        expect(await recommendFastCheck(root)).toBe(false) // deno
    })
})

describe('resolveGateContract — refusals', () => {
    it('custom stack refuses naming the npm/deno remedies', async () => {
        await expect(
            resolveGateContract({targetRoot: root, waiveMutation: false, waiveCoverage: false})
        ).rejects.toThrow(/custom.*package\.json.*deno\.json/s)
    })

    it('npm with a broken package.json fails loud', async () => {
        await writeFile(join(root, 'package.json'), '{ nope', 'utf8')
        await expect(
            resolveGateContract({targetRoot: root, waiveMutation: false, waiveCoverage: false})
        ).rejects.toThrow(/package\.json is not valid JSON/)
    })
})

describe('DEFAULT_GATES ↔ resolver reality', () => {
    it('every resolver contracts every DEFAULT_GATES id (pins the floor constant to scaffold)', async () => {
        await npmFixture({'@stryker-mutator/core': '1', '@vitest/coverage-v8': '1'})
        await mkdir(join(root, 'src'), {recursive: true})
        await writeFile(join(root, 'src', 'main.ts'), 'export const one = 1\n', 'utf8')
        const npm = await resolveGateContract({targetRoot: root, waiveMutation: false, waiveCoverage: false})
        for (const id of DEFAULT_GATES) {
            expect(npm.gates[id].contracted, `npm must contract '${id}'`).toBe(true)
        }
        await rm(join(root, 'package.json'), {force: true})
        await writeFile(join(root, 'deno.json'), JSON.stringify({tasks: {build: 'deno run -A build.ts'}}), 'utf8')
        const deno = await resolveGateContract({targetRoot: root, waiveMutation: true, waiveCoverage: true})
        for (const id of DEFAULT_GATES) {
            expect(deno.gates[id].contracted, `deno must contract '${id}'`).toBe(true)
        }
    })
})

describe('detectMutationRoots + contract roots (A4)', () => {
    const stryker = {'@stryker-mutator/core': '1', '@vitest/coverage-v8': '1'}

    it('src/ with mutable .ts → default (contract omits roots)', async () => {
        await npmFixture(stryker)
        await mkdir(join(root, 'src'), {recursive: true})
        await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
        const c = await resolveGateContract({targetRoot: root, waiveMutation: false, waiveCoverage: false})
        expect(c.gates.mutation).toEqual({contracted: true})
        expect(detectMutationRoots(root)).toBeUndefined()
    })

    it('no src/: candidate dirs with mutable .ts are contracted explicitly', async () => {
        await npmFixture(stryker)
        await mkdir(join(root, 'app', 'account'), {recursive: true})
        await writeFile(join(root, 'app', 'account', 'page.ts'), 'export const p = 1\n', 'utf8')
        await mkdir(join(root, 'utils'), {recursive: true})
        await writeFile(join(root, 'utils', 'fmt.ts'), 'export const f = 1\n', 'utf8')
        // Dirs with only excluded files do NOT count as roots.
        await mkdir(join(root, 'lib'), {recursive: true})
        await writeFile(join(root, 'lib', 'x.test.ts'), 'export const t = 1\n', 'utf8')
        const c = await resolveGateContract({targetRoot: root, waiveMutation: false, waiveCoverage: false})
        expect(c.gates.mutation).toEqual({contracted: true, roots: ['app', 'utils']})
    })

    it('src/ containing ONLY excluded files falls through to candidates', async () => {
        await npmFixture(stryker)
        await mkdir(join(root, 'src'), {recursive: true})
        await writeFile(join(root, 'src', 'a.test.ts'), 'export const t = 1\n', 'utf8')
        await mkdir(join(root, 'db'), {recursive: true})
        await writeFile(join(root, 'db', 'schema.ts'), 'export const s = 1\n', 'utf8')
        expect(detectMutationRoots(root)).toEqual(['db'])
    })

    it('stryker installed but NO mutable roots anywhere → loud refusal (never a silent no-op)', async () => {
        await npmFixture(stryker)
        await expect(
            resolveGateContract({targetRoot: root, waiveMutation: false, waiveCoverage: false})
        ).rejects.toThrow(/no mutable-source roots.*silent no-op/s)
    })

    it('--waive mutation sidesteps the roots refusal', async () => {
        await npmFixture(stryker)
        const c = await resolveGateContract({targetRoot: root, waiveMutation: true, waiveCoverage: false})
        expect(c.gates.mutation).toEqual({contracted: false, reason: 'waived via --waive mutation'})
    })
})
