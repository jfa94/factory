/**
 * Tiny fs probes + path canonicalization shared across seams (deterministic
 * gates, e2e runner, worktree provision, TCB hooks, record cores) — each
 * previously carried its own copy.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- probe on internal derived paths, never external input */
import {existsSync, realpathSync} from 'node:fs'
import {access} from 'node:fs/promises'
import {isAbsolute, normalize, resolve, sep} from 'node:path'

/** True iff the path exists (any dirent kind). The injectable default across tool seams. */
export async function pathExists(absPath: string): Promise<boolean> {
    try {
        await access(absPath)
        return true
    } catch {
        return false
    }
}

/**
 * Canonicalize a candidate path for matching: resolve to absolute (relative to
 * `cwd`), normalize away `./` and `..`, then realpath-resolve if it (or its
 * nearest existing parent) exists — defeating symlink escapes. A non-existent
 * path falls back to its normalized absolute form (the write may be a create).
 */
export function canonicalizePath(candidate: string, cwd: string = process.cwd()): string {
    const abs = isAbsolute(candidate) ? candidate : resolve(cwd, candidate)
    const normalized = normalize(abs)
    // Realpath the deepest existing ancestor so a symlinked parent dir is resolved
    // even when the leaf file does not yet exist (a create through a symlink).
    try {
        if (existsSync(normalized)) {
            return realpathSync(normalized)
        }
    } catch {
        /* realpath can race; fall through to the normalized form */
    }
    // Walk up to the nearest existing ancestor, realpath it, re-append the tail.
    const parts = normalized.split(sep)
    for (let cut = parts.length - 1; cut > 0; cut--) {
        const ancestor = parts.slice(0, cut).join(sep) || sep
        try {
            if (existsSync(ancestor)) {
                const realAncestor = realpathSync(ancestor)
                const tail = parts.slice(cut).join(sep)
                return tail.length > 0 ? resolve(realAncestor, tail) : realAncestor
            }
        } catch {
            /* keep walking up */
        }
    }
    return normalized
}
