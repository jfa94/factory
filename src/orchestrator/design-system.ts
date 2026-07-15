/* eslint-disable security/detect-non-literal-fs-filename -- read-only repo introspection under the caller-supplied root */
import {readdir} from 'node:fs/promises'
import {join, relative} from 'node:path'

const FRONTEND_EXTENSION = /\.(?:tsx|jsx|vue|svelte|css|scss|less)$/i
const FRONTEND_DIRECTORY = /(?:^|\/)(?:components|pages|app)\//i
const DESIGN_SYSTEM_DOC = /design[-_]?system|style[-_]?guide|design[-_]?tokens|ui[-_]?guidelines/i
const MAX_DEPTH = 4

/** Heuristic over a repo-relative spec path; no working-tree diff exists yet. */
export function isFrontendPath(path: string): boolean {
    return FRONTEND_EXTENSION.test(path) || FRONTEND_DIRECTORY.test(path.replaceAll('\\', '/'))
}

/** Find design-system documentation below docs/, returning stable repo-relative paths. */
export async function findDesignSystemDocs(repoRoot: string): Promise<string[]> {
    const docsRoot = join(repoRoot, 'docs')
    const matches: string[] = []

    async function scan(dir: string, depth: number): Promise<void> {
        let entries
        try {
            entries = await readdir(dir, {withFileTypes: true})
        } catch (err) {
            if (dir === docsRoot && (err as NodeJS.ErrnoException).code === 'ENOENT') {
                return
            }
            throw err
        }

        await Promise.all(
            entries.map(async (entry) => {
                const absolute = join(dir, entry.name)
                if (entry.isDirectory()) {
                    if (depth < MAX_DEPTH) {
                        await scan(absolute, depth + 1)
                    }
                    return
                }
                if (entry.isFile()) {
                    const repoRelative = relative(repoRoot, absolute).replaceAll('\\', '/')
                    if (DESIGN_SYSTEM_DOC.test(repoRelative)) {
                        matches.push(repoRelative)
                    }
                }
            })
        )
    }

    await scan(docsRoot, 0)
    return matches.sort()
}
