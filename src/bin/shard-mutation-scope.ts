/**
 * `shard-mutation-scope` — the CLI shim the factory CI `mutation-scope` job runs
 * to split a PR's changed mutable-source files across the Stryker shard matrix.
 *
 * esbuild bundles THIS file into the checked-in, dependency-free scaffold template
 * `templates/.github/scripts/shard-mutation-scope.mjs` (see scripts/build.mjs). It
 * is the ONLY I/O layer over the pure {@link shardByCost} packer: it reads the
 * comma-separated scope (argv[2], falling back to $SCOPE), weights each file by its
 * {@link sloc} read from the checked-out tree (weight 1 on any read failure — a
 * missing path must never crash the split), LPT-packs into {@link SHARD_COUNT}
 * shards, and prints the JSON array of comma-joined slices to stdout.
 *
 * The shard count is fixed to match the workflow's static `[1,2,3,4]` matrix and
 * the "Mutation Testing" branch-protection check; do not make it dynamic without
 * also reworking that contract.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- fs on internal derived paths (run/spec/state/repo/data dirs), never external input; runtime write-danger is covered by the TCB write-deny hook */
import {readFileSync} from 'node:fs'

import {shardByCost, sloc} from '../verifier/deterministic/shard.js'

/** Matches the static `mutation` matrix in templates/.github/workflows/quality-gate.yml. */
export const SHARD_COUNT = 4

/** Read `file`'s sloc weight; any failure (missing/unreadable) defaults to 1. */
function weightOf(file: string): number {
    try {
        return sloc(readFileSync(file, 'utf8')) || 1
    } catch {
        return 1
    }
}

function main(scopeCsv: string): void {
    const files = scopeCsv
        .split(',')
        .map((f) => f.trim())
        .filter((f) => f !== '')
    const weights = files.map(weightOf)
    const shards = shardByCost(files, weights, SHARD_COUNT)
    process.stdout.write(JSON.stringify(shards) + '\n')
}

main(process.argv[2] ?? process.env.SCOPE ?? '')
