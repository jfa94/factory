/**
 * Shared stdin reader. Lives in `shared/` (not `hooks/`) so BOTH the hook layer
 * and the CLI can consume it without a cli→hooks dependency edge: the dependency
 * direction stays one-way (cli→shared, hooks→shared). `hooks/hook-io.ts`
 * re-exports it for back-compat with existing hook call sites.
 */

/**
 * Read the entire stdin stream as a utf-8 string. Injectable for tests via the
 * `stream` arg (any async-iterable of chunks).
 */
export async function readStdin(
  stream: AsyncIterable<string | Uint8Array> = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
