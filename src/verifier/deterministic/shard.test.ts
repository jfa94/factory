/**
 * Stable-hash mutation sharding vectors. Pins the two invariants the CI workflow
 * depends on (output length === shard count; empty scope → empty shards) plus the
 * property the hash split exists for: a file's shard NEVER depends on what else
 * is in scope, so per-shard incremental caches stay aligned across PRs, rollups,
 * and the nightly full-surface seeding run.
 */
import {describe, expect, it} from 'vitest'
import {fnv1a, shardByHash} from './shard.js'

describe('shardByHash — structural contracts (load-bearing for the CI matrix)', () => {
    it('returns exactly n shards regardless of file count', () => {
        expect(shardByHash([], 4)).toHaveLength(4)
        expect(shardByHash(['a.ts'], 4)).toHaveLength(4)
        expect(shardByHash(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], 4)).toHaveLength(4)
    })

    it('maps an empty scope to n empty strings', () => {
        expect(shardByHash([], 4)).toEqual(['', '', '', ''])
    })

    it('returns [] for n === 0', () => {
        expect(shardByHash(['a.ts'], 0)).toEqual([])
    })

    it('partitions every file exactly once (no loss, no duplication)', () => {
        const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts']
        const out = shardByHash(files, 4)
        const placed = out.flatMap((csv) => (csv === '' ? [] : csv.split(',')))
        expect(placed.slice().sort()).toEqual(files.slice().sort())
        expect(placed).toHaveLength(files.length)
    })
})

describe('shardByHash — stability (the whole point)', () => {
    it('is deterministic — identical inputs yield identical assignments', () => {
        const files = ['src/x.ts', 'src/y.ts', 'src/z.ts', 'src/w.ts']
        expect(shardByHash(files, 4)).toEqual(shardByHash(files, 4))
    })

    it("a file's shard is independent of the rest of the scope", () => {
        const surface = Array.from({length: 40}, (_, i) => `src/mod-${i}/file-${i}.ts`)
        const full = shardByHash(surface, 4)
        const shardOf = (file: string, shards: string[]): number =>
            shards.findIndex((csv) => csv.split(',').includes(file))
        // Every subset — a PR diff — lands each file on its full-surface shard.
        const diff = [surface[3], surface[17], surface[31]] as string[]
        const diffShards = shardByHash(diff, 4)
        for (const file of diff) {
            expect(shardOf(file, diffShards)).toBe(shardOf(file, full))
        }
    })

    it('spreads a realistic surface across all shards', () => {
        const surface = Array.from({length: 100}, (_, i) => `src/dir-${i % 7}/module-${i}.ts`)
        const out = shardByHash(surface, 4)
        expect(out.every((csv) => csv !== '')).toBe(true)
    })
})

describe('shardByHash — glob escaping for --mutate CSV', () => {
    it('escapes glob metacharacters in dynamic-route paths', () => {
        const files = ['src/app/feedback/[token]/actions.ts', 'src/normal.ts']
        const out = shardByHash(files, 2)
        const entries = out.flatMap((csv) => (csv === '' ? [] : csv.split(',')))
        expect(entries).toContain('src/app/feedback/[[]token[]]/actions.ts')
        expect(entries).toContain('src/normal.ts')
        expect(entries).not.toContain('src/app/feedback/[token]/actions.ts')
    })

    it('hashes the RAW path, not the escaped form (escaping must not move a file)', () => {
        const raw = 'src/app/[id]/page.ts'
        const out = shardByHash([raw], 4)
        expect(out[fnv1a(raw) % 4]).toBe('src/app/[[]id[]]/page.ts')
    })
})

describe('fnv1a — pinned vectors (assignment must never drift between releases)', () => {
    it('matches the FNV-1a 32-bit reference values', () => {
        expect(fnv1a('')).toBe(0x811c9dc5)
        expect(fnv1a('a')).toBe(0xe40c292c)
        expect(fnv1a('foobar')).toBe(0xbf9cf968)
    })
})
