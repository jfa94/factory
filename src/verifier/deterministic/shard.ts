import {escapeStrykerGlob} from './scope.js'

/**
 * Stable-hash mutation sharding (the splitter behind the CI `mutation-scope` job
 * and the nightly warm-base seeding run).
 *
 * A file's shard is a pure function of its PATH — `fnv1a(path) % n` — so the
 * assignment is stable across diffs, branches, and repo evolution. That stability
 * is the point: each shard owns a Stryker incremental cache, and the nightly
 * develop run seeds those caches for the WHOLE mutable surface (default-branch
 * caches are readable by every PR). A PR's diff files land on exactly the shards
 * whose caches already hold their prior results, so only genuinely changed
 * mutants re-run. The previous LPT-by-sloc packer balanced a single run better,
 * but reshuffled files between shards whenever the scope changed — invalidating
 * the incremental caches that dominate real-world cost.
 *
 * Pure string/number functions — no I/O, deterministic.
 */

/** 32-bit FNV-1a over the code units of `s`. */
export function fnv1a(s: string): number {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
    }
    return h >>> 0
}

/**
 * Split `files` across `n` shards by stable hash: `shard(file) = fnv1a(file) % n`.
 *
 * Returns EXACTLY `n` comma-joined CSV strings (the `mutation` matrix is static
 * `[1..n]` and indexes the result positionally), so an empty input yields `n`
 * empty strings. Paths are glob-escaped for Stryker's `--mutate` matcher; input
 * order is preserved within a shard.
 */
export function shardByHash(files: readonly string[], n: number): string[] {
    const bins: string[][] = Array.from({length: Math.max(0, n)}, () => [])
    if (bins.length === 0) {
        return []
    }
    for (const file of files) {
        bins[fnv1a(file) % bins.length]?.push(file)
    }
    return bins.map((b) => b.map(escapeStrykerGlob).join(','))
}
