/**
 * JSONL (newline-delimited JSON) append helpers — the substrate for WS12's
 * append-only run logs (metrics + audit).
 *
 * Distinct from `json.ts` (whole-file, atomically-replaced, pretty-printed): a
 * jsonl log GROWS one record per line and is appended, never rewritten. Each
 * record is serialized COMPACT (single line) so one `appendFile` writes exactly
 * one log line.
 *
 * Durability note (honest): unlike the atomic-write seam, an append is NOT fsynced
 * — a crash mid-append can leave a torn final line. That is the right trade for a
 * high-frequency telemetry log (fsync-per-metric would dominate run cost), and
 * {@link readJsonl} tolerates a torn trailing line by failing loud with its line
 * number rather than silently dropping data. Load-bearing state never lives here;
 * it lives in `state.json` (atomic). These logs are observability only.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- fs seam: paths are internal derived run/spec/state/repo paths, never external input; runtime write-danger is covered by the TCB write-deny hook */
import {appendFile, mkdir, readFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {JsonParseError} from './json.js'
import {at} from './assert.js'

/**
 * Append one record as a single compact JSON line to `path`, creating parent
 * directories as needed. The record MUST serialize to a single line (no embedded
 * newline survives `JSON.stringify` of a string — they are escaped — so this holds
 * for any JSON-serializable value).
 */
export async function appendJsonl(path: string, record: unknown): Promise<void> {
    await mkdir(dirname(path), {recursive: true})
    await appendFile(path, JSON.stringify(record) + '\n', 'utf8')
}

/**
 * Read + parse every line of a jsonl file. A missing file is an empty log (`[]`),
 * NOT an error — a run that emitted no metrics simply has no file yet. Blank lines
 * are skipped. A line that fails to parse throws a {@link JsonParseError} naming
 * the 1-based line number, so a torn/corrupt log is loud, never silently truncated.
 */
export async function readJsonl<T = unknown>(path: string): Promise<T[]> {
    let text: string
    try {
        text = await readFile(path, 'utf8')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return []
        }
        throw err
    }
    const out: T[] = []
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const line = at(lines, i).trim()
        if (line.length === 0) {
            continue
        }
        try {
            out.push(JSON.parse(line) as T)
        } catch (cause) {
            throw new JsonParseError(`invalid JSONL at ${path}:${i + 1}: ${(cause as Error).message}`, path, cause)
        }
    }
    return out
}
