/**
 * JSON file helpers — frozen seam.
 *
 * Reads are LOCK-FREE (matches the state model: only mutations take a lock;
 * readers never do). Writes go through the atomic-write primitive so a JSON file
 * is never observed half-written.
 *
 * Parse failures throw a typed {@link JsonParseError} carrying the source path —
 * callers (e.g. config load) surface it loudly rather than silently defaulting.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { atomicWriteFile, atomicWriteFileSync } from "./atomic-write.js";

/** Thrown when JSON text cannot be parsed. Carries the offending source path. */
export class JsonParseError extends Error {
  readonly path: string | undefined;
  override readonly cause: unknown;
  constructor(message: string, path: string | undefined, cause: unknown) {
    super(message);
    this.name = "JsonParseError";
    this.path = path;
    this.cause = cause;
  }
}

/** Parse JSON text, throwing {@link JsonParseError} on failure. */
export function parseJson<T = unknown>(text: string, sourcePath?: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    const where = sourcePath ? ` (from ${sourcePath})` : "";
    throw new JsonParseError(
      `invalid JSON${where}: ${(cause as Error).message}`,
      sourcePath,
      cause,
    );
  }
}

/** Synchronously read+parse a JSON file (lock-free). */
export function readJsonFileSync<T = unknown>(path: string): T {
  return parseJson<T>(readFileSync(path, "utf8"), path);
}

/** Asynchronously read+parse a JSON file (lock-free). */
export async function readJsonFile<T = unknown>(path: string): Promise<T> {
  return parseJson<T>(await readFile(path, "utf8"), path);
}

/** Stable, pretty (2-space) JSON serialization with a trailing newline. */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Atomically (and durably) write `value` as pretty JSON. Sync variant. */
export function writeJsonFileSync(path: string, value: unknown): void {
  atomicWriteFileSync(path, stringifyJson(value));
}

/** Atomically (and durably) write `value` as pretty JSON. Async variant. */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, stringifyJson(value));
}
