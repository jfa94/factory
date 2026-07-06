/**
 * Shared shell-token helpers for the hook guards (write-protection, git-args,
 * secret-guard). Pure string utilities — no I/O, no hook-io dependency.
 */

/** Compound-command / substitution splitter (segments between &&, ||, ;, pipes, subshells). */
export const SEGMENT_SPLIT_RE = /&&|\|\||;|&|\||\n|\$\(|`|\)/

/** Strip one layer of surrounding single/double quotes from a token. */
export function unquote(tok: string): string {
    let t = tok
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
        t = t.slice(1, -1)
    }
    if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
        t = t.slice(1, -1)
    }
    return t
}

/** Basename of a path-like token (last `/`-separated component). */
export function basenameOf(tok: string): string {
    const parts = tok.split('/')
    return parts[parts.length - 1] ?? tok
}
