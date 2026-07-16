/**
 * Durable per-spec shipped-work ledger (Decision 70).
 *
 * `specDir(...)/ledger.json` — a sibling of tasks.json that records, per task,
 * WHICH commits shipped it and (when known) the PR number. Two writers:
 *   - finalize.ts appends `source: 'shipped'` entries after a MERGED rollup
 *     (the develop tip is the recorded SHA — task squash SHAs are never
 *     ancestors of future bases, the rollup tip is);
 *   - record.ts appends `source: 'already-satisfied'` entries when it verifies
 *     a producer's ALREADY_SATISFIED claim against the base.
 * One reader that matters: `createRunFromManifest` seeds a task `done` when
 * every SHA of its latest entry is an ancestor of the fresh staging tip.
 *
 * ENOENT reads as an empty ledger; garbage/schema-invalid content throws LOUD
 * (a corrupt ledger silently read as empty would re-run shipped work).
 */
/* eslint-disable security/detect-non-literal-fs-filename -- fs seam: paths are internal derived spec paths, never external input; runtime write-danger is covered by the TCB write-deny hook */
import {readFile, mkdir} from 'node:fs/promises'
import {join, dirname} from 'node:path'
import {z} from 'zod'

import {specDir} from '../core/state/paths.js'
import {atomicWriteFile} from '../shared/atomic-write.js'
import {isEnoent} from '../shared/fs-errors.js'
import {parseJson, stringifyJson} from '../shared/json.js'

const LEDGER_FILE = 'ledger.json'

const LedgerEntrySchema = z
    .object({
        task_id: z.string().min(1),
        run_id: z.string().min(1),
        /** GitHub PR number, when the entry came from a shipped PR. */
        pr_number: z.number().int().positive().optional(),
        /** The commit SHAs that carry this task's work (min 1 — an unevidenced entry is useless). */
        shas: z.array(z.string().min(7)).min(1),
        verified_at: z.string().min(1),
        source: z.enum(['shipped', 'already-satisfied']),
    })
    .strict()

const LedgerSchema = z.object({entries: z.array(LedgerEntrySchema)}).strict()

export type LedgerEntry = z.infer<typeof LedgerEntrySchema>
export type Ledger = z.infer<typeof LedgerSchema>

function ledgerPath(dataDir: string, repo: string, specId: string): string {
    return join(specDir(dataDir, repo, specId), LEDGER_FILE)
}

/** Read the spec's ledger. Missing file → empty ledger; garbage → LOUD throw. */
export async function readLedger(dataDir: string, repo: string, specId: string): Promise<Ledger> {
    const path = ledgerPath(dataDir, repo, specId)
    let raw: string
    try {
        raw = await readFile(path, 'utf8')
    } catch (err) {
        if (isEnoent(err)) {
            return {entries: []}
        }
        throw err
    }
    return LedgerSchema.parse(parseJson(raw, path))
}

/** Append entries to the spec's ledger (read-modify-write, atomic rename on write). */
// ponytail: no file lock — single-process writers today (finalize + record run in one CLI); add withFileLock if a second writer process ever appears
export async function appendLedgerEntries(
    dataDir: string,
    repo: string,
    specId: string,
    entries: readonly LedgerEntry[]
): Promise<void> {
    const path = ledgerPath(dataDir, repo, specId)
    const current = await readLedger(dataDir, repo, specId)
    const next = LedgerSchema.parse({entries: [...current.entries, ...entries]})
    await mkdir(dirname(path), {recursive: true})
    await atomicWriteFile(path, stringifyJson(next))
}

/** The LAST (most recent — append order is chronological) entry per task_id. */
export function latestByTask(ledger: Ledger): Map<string, LedgerEntry> {
    const map = new Map<string, LedgerEntry>()
    for (const e of ledger.entries) {
        map.set(e.task_id, e)
    }
    return map
}
