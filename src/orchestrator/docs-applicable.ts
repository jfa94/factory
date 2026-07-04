/* eslint-disable security/detect-non-literal-fs-filename -- fs on internal derived paths (run/spec/state/repo/data dirs), never external input; runtime write-danger is covered by the TCB write-deny hook */
import {readFile, stat} from 'node:fs/promises'
import {join} from 'node:path'

async function readJsonOrNull(file: string): Promise<unknown> {
    let raw: string
    try {
        raw = await readFile(file, 'utf8')
    } catch {
        return null
    }
    try {
        return JSON.parse(raw)
    } catch {
        return null
    }
}

function docsEnabled(packageJson: unknown): boolean {
    // Default ON. Disabled only by an explicit factory.docs.enabled === false.
    const enabled = (packageJson as {factory?: {docs?: {enabled?: unknown}}} | null)?.factory?.docs?.enabled
    return enabled !== false
}

/** True iff the target repo keeps a /docs directory AND docs are not opted out. */
export async function isDocsApplicable(repoRoot: string): Promise<boolean> {
    try {
        const s = await stat(join(repoRoot, 'docs'))
        if (!s.isDirectory()) {
            return false
        }
    } catch {
        return false
    }
    return docsEnabled(await readJsonOrNull(join(repoRoot, 'package.json')))
}
