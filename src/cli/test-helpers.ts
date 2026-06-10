/**
 * Shared test utilities for CLI shell tests.
 *
 * Not a test suite — contains no describe/it blocks. Vitest only collects *.test.ts
 * files, so this file is never run as a suite.
 */

export interface CapturedStream {
  /** Returns all data written to the stream since capture began. */
  read(): string;
  /** Restores the original write implementation. */
  restore(): void;
}

/**
 * Intercepts `write` on a Node.js writable stream (stdout/stderr), collects all
 * string and Buffer chunks, and returns a handle with `read()` and `restore()`.
 * The caller is responsible for calling `restore()` — typically in a `finally` block.
 */
export function captureStream(stream: NodeJS.WritableStream): CapturedStream {
  const chunks: string[] = [];
  const original = (stream as NodeJS.WriteStream).write.bind(stream);
  (stream as NodeJS.WriteStream).write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  };
  return {
    read: () => chunks.join(""),
    restore: () => {
      (stream as NodeJS.WriteStream).write = original;
    },
  };
}
