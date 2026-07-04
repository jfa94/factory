/**
 * S8 — persisted per-tree-SHA coverage summaries (`runs/<run-id>/coverage/`).
 *
 * WHY this persists while GateMemo (memo.ts) deliberately does not: every gate
 * sweep runs in a SEPARATE CLI process (`factory next-action` / record), so an
 * in-memory memo cannot stop the full test suite from being re-measured — twice
 * (head + base) — on every sweep of every task. The store is NOT the stored-
 * verdict smell memo.ts guards against: the key is a content-addressed git tree
 * SHA (an immutable content→summary mapping that cannot go stale), the value is
 * a raw measurement, and the gate VERDICT is still re-derived fresh on every
 * run. Post-squash the staging tip's tree equals the merged task's head tree,
 * so later tasks' base lookups are served by earlier tasks' head measurements.
 *
 * Accepted edge (documented, not defended): the key does NOT encode the
 * measurement command, so editing the contract's coverage command mid-run can
 * leave a base entry measured under the old command. Bounded to one run dir.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- fs seam: paths are internal derived run/spec/state/repo paths, never external input; runtime write-danger is covered by the TCB write-deny hook */
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import path from 'node:path'
import type {CoverageSummary} from './tools.js'

/** Content-addressed git object sha: 40 hex (sha1) or 64 hex (sha256 repos). */
const TREE_SHA_RE = /^[0-9a-f]{40,64}$/

/** Per-run persisted coverage summaries, keyed by git tree SHA. */
export interface CoverageStore {
    /** Cached summary for a tree SHA, or null on a miss. Throws LOUD on a corrupt entry. */
    get(treeSha: string): Promise<CoverageSummary | null>
    /** Persist atomically (tmp + rename). Concurrent duplicate puts are benign (same content). */
    put(treeSha: string, summary: CoverageSummary): Promise<void>
}

/** The stored shape is the bare {@link CoverageSummary} — validate all four metrics. */
function isSummary(v: unknown): v is CoverageSummary {
    if (typeof v !== 'object' || v === null) {
        return false
    }
    const o = v as Record<string, unknown>
    return (['lines', 'branches', 'functions', 'statements'] as const).every(
        (k) => typeof o[k] === 'number' && Number.isFinite(o[k])
    )
}

/** Filesystem {@link CoverageStore} over `<dir>/<treeSha>.json`. */
export class FsCoverageStore implements CoverageStore {
    /** Distinguishes same-process concurrent puts' tmp files (pid covers cross-process). */
    private seq = 0

    constructor(private readonly dir: string) {}

    private file(treeSha: string): string {
        // The key becomes a path segment — refuse anything but a bare hex sha.
        if (!TREE_SHA_RE.test(treeSha)) {
            throw new Error(`coverage store: invalid tree sha key '${treeSha}'`)
        }
        return path.join(this.dir, `${treeSha}.json`)
    }

    async get(treeSha: string): Promise<CoverageSummary | null> {
        const file = this.file(treeSha)
        let raw: string
        try {
            raw = await readFile(file, 'utf8')
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return null
            }
            throw err
        }
        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch {
            parsed = null
        }
        // Writes are atomic, so a corrupt entry is a store-integrity defect — fail
        // LOUD rather than silently re-measure over it.
        if (!isSummary(parsed)) {
            throw new Error(`coverage store: corrupt entry ${file} — delete it and re-run`)
        }
        return parsed
    }

    async put(treeSha: string, summary: CoverageSummary): Promise<void> {
        const target = this.file(treeSha)
        await mkdir(this.dir, {recursive: true})
        const tmp = path.join(this.dir, `.tmp-${treeSha}-${process.pid}-${this.seq++}`)
        await writeFile(tmp, JSON.stringify(summary), 'utf8')
        await rename(tmp, target)
    }
}
