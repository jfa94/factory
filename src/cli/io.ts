/**
 * CLI output helpers. The contract the in-session runner relies on:
 *   - A machine subcommand (drive, next, state, spec, …) emits EXACTLY ONE JSON
 *     document to stdout (via {@link emitJson}) — the runner parses it.
 *   - Human output (`--help`, `state --summary`) goes to stdout as plain lines
 *     (via {@link emitLine}); the runner never invokes those forms.
 *   - DIAGNOSTICS/logs go to stderr (via `createLogger`), never stdout.
 * A single invocation emits only ONE kind, so the parse stays unambiguous.
 */
import {stringifyJson} from '../shared/json.js'

/** Write one JSON document to stdout (newline-terminated) — the machine surface. */
export function emitJson(value: unknown): void {
    process.stdout.write(stringifyJson(value) + '\n')
}

/** Write a plain human line to stdout (for `--help` / human summaries). */
export function emitLine(line: string): void {
    process.stdout.write(line + '\n')
}

/** Write a human error line to stderr (usage errors, diagnostics). */
export function emitError(line: string): void {
    process.stderr.write(line + '\n')
}
