/**
 * JSON file helpers — frozen seam.
 *
 * Reads are LOCK-FREE (matches the state model: only mutations take a lock;
 * readers never do). Writes go through the atomic-write primitive so a JSON file
 * is never observed half-written.
 *
 * Parse failures throw a typed {@link JsonParseError} carrying the source path —
 * callers (e.g. config load) surface it loudly rather than silently defaulting.
 *
 * This module is the sanctioned JSON fs seam: every read/write here takes a
 * caller-supplied path that is an INTERNAL derived path (run/spec/state dir),
 * never external input, and runtime write-danger is covered by the TCB
 * write-deny hook — so `detect-non-literal-fs-filename` is disabled file-wide
 * rather than per-call. Route JSON fs through here instead of raw node:fs.
 */
/* eslint-disable security/detect-non-literal-fs-filename */
import {readFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {atomicWriteFile, atomicWriteFileSync} from './atomic-write.js'

/** Thrown when JSON text cannot be parsed. Carries the offending source path. */
export class JsonParseError extends Error {
    readonly path: string | undefined
    override readonly cause: unknown
    constructor(message: string, path: string | undefined, cause: unknown) {
        super(message)
        this.name = 'JsonParseError'
        this.path = path
        this.cause = cause
    }
}

/**
 * Parse JSON text, throwing {@link JsonParseError} on failure. Returns `unknown`
 * on purpose: JSON is untyped at the boundary, so callers must validate (Zod) or
 * narrow before use rather than trust a cast.
 */
export function parseJson(text: string, sourcePath?: string): unknown {
    try {
        return JSON.parse(text)
    } catch (cause) {
        const where = sourcePath != null ? ` (from ${sourcePath})` : ''
        throw new JsonParseError(`invalid JSON${where}: ${(cause as Error).message}`, sourcePath, cause)
    }
}

/** Synchronously read+parse a JSON file (lock-free). Returns `unknown` — validate before use. */
export function readJsonFileSync(path: string): unknown {
    return parseJson(readFileSync(path, 'utf8'), path)
}

/**
 * Asynchronously read+parse a JSON file (lock-free). The optional `<T>` is a
 * caller-asserted shape for reading our OWN serialized files (state/spec/debug);
 * for external payloads use {@link parseJson} + a Zod schema instead.
 */
export async function readJsonFile<T = unknown>(path: string): Promise<T> {
    return parseJson(await readFile(path, 'utf8'), path) as T
}

/** Stable, pretty (2-space) JSON serialization with a trailing newline. */
export function stringifyJson(value: unknown): string {
    return JSON.stringify(value, null, 2) + '\n'
}

/** Atomically (and durably) write `value` as pretty JSON. Sync variant. */
export function writeJsonFileSync(path: string, value: unknown): void {
    atomicWriteFileSync(path, stringifyJson(value))
}

/** Atomically (and durably) write `value` as pretty JSON. Async variant. */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
    await atomicWriteFile(path, stringifyJson(value))
}
