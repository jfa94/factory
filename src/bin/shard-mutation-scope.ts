/**
 * `shard-mutation-scope` — the CLI shim the factory CI `mutation-scope` job (and
 * the nightly warm-base seeding job) runs to split mutable-source files across
 * the Stryker shard matrix.
 *
 * esbuild bundles THIS file into the checked-in, dependency-free scaffold template
 * `templates/.github/scripts/shard-mutation-scope.mjs` (see scripts/build.mjs). It
 * is the ONLY shell layer over the pure {@link shardByHash} splitter: it reads the
 * comma-separated scope (argv[2], falling back to $SCOPE), hash-assigns each file
 * to its stable home shard, and prints the JSON array of comma-joined slices to
 * stdout. No I/O — the caller owns scope computation (git diff for PRs, git
 * ls-files for the nightly full surface).
 *
 * The shard count is fixed to match the workflows' static `[1..8]` matrix and
 * the "Mutation Testing" branch-protection check; do not make it dynamic without
 * also reworking that contract.
 */
import {shardByHash} from '../verifier/deterministic/shard.js'

/**
 * Matches the static `mutation` matrix in templates/.github/workflows/quality-gate.yml
 * AND mutation-nightly.yml. 8 (not 4): the nightly warm-base run mutates the WHOLE
 * mutable surface, and on a 2-vCPU runner a quarter of a large surface busts GitHub's
 * 6h job cap; halving each shard keeps the slowest under the 360m nightly timeout.
 */
export const SHARD_COUNT = 8

function main(scopeCsv: string): void {
    const files = scopeCsv
        .split(',')
        .map((f) => f.trim())
        .filter((f) => f !== '')
    const shards = shardByHash(files, SHARD_COUNT)
    process.stdout.write(JSON.stringify(shards) + '\n')
}

main(process.argv[2] ?? process.env.SCOPE ?? '')
