/**
 * WS9 — PreToolUse Edit|Write|MultiEdit guard: the primary "implementer cannot
 * modify any TCB path" enforcer (Δ B/W/Y).
 *
 * Extracts every target file_path from the tool input (Edit/Write `.file_path`
 * plus MultiEdit `.edits[].file_path`), canonicalizes each, and DENIES if ANY is
 * a TCB-protected path ({@link isTcbProtected}). The denylist is HARDCODED in
 * tcb.ts and is NEVER consulted from config — the load-bearing kill of the
 * circular config bypass (Δ W). This is unconditional: it does not depend on a
 * run being active or on config state; an implementer must never edit a TCB path.
 *
 * The data dir (so the out-of-repo `runs/**`/`specs/**` stores match at their
 * absolute paths) is resolved best-effort via the Config seam — PATH RESOLUTION
 * only, never policy (see tcb.ts header). If the data dir cannot be resolved the
 * component-anchored TCB rules still fire.
 */
import { EXIT, type ExitCode } from "../shared/exit-codes.js";
import { resolveDataDir, type DataDirOptions } from "../config/load.js";
import { isTcbProtected, type TcbContext } from "./tcb.js";
import {
  allow,
  deny,
  decisionToExitCode,
  emitPermissionDecision,
  filePathsOf,
  parseHookInput,
  toolNameOf,
  type HookDecision,
  type HookInput,
} from "./hook-io.js";

/** Tools that perform a write and are therefore subject to TCB write-deny. */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/** Options for {@link decideWriteProtection} (all injectable). */
export interface WriteProtectionDeps extends DataDirOptions {
  /** cwd for path canonicalization (defaults to process.cwd()). */
  cwd?: string;
  /** Repo root for the `hooks/**` rule (defaults to cwd). */
  repoRoot?: string;
}

/** Resolve the TCB context (data dir + repo root) for a check, best-effort. */
function resolveTcbContext(deps: WriteProtectionDeps): TcbContext {
  const cwd = deps.cwd ?? process.cwd();
  let dataDir: string | undefined;
  try {
    dataDir = resolveDataDir(deps);
  } catch {
    dataDir = undefined;
  }
  return { repoRoot: deps.repoRoot ?? cwd, dataDir };
}

/**
 * Decide whether a write tool invocation must be blocked for touching a TCB path.
 * Pure-ish (only reads the data dir via the Config seam for path resolution).
 * A MultiEdit is blocked if ANY of its targets is TCB-protected.
 */
export function decideWriteProtection(
  input: HookInput | null,
  deps: WriteProtectionDeps = {},
): HookDecision {
  const tool = toolNameOf(input);
  if (!WRITE_TOOLS.has(tool)) return allow();

  const targets = filePathsOf(input);
  if (targets.length === 0) return allow();

  const ctx = resolveTcbContext(deps);
  const cwd = deps.cwd ?? process.cwd();

  for (const target of targets) {
    const match = isTcbProtected(target, ctx, cwd);
    if (match) {
      return deny(
        "tcb_write_denied",
        `${tool} to TCB-protected path '${match.canonical}' is forbidden ` +
          `(category=${match.rule.category}: ${match.rule.describe})`,
      );
    }
  }
  return allow();
}

/**
 * Run the write-protection guard end-to-end: read+parse stdin, decide, emit the
 * permission-decision JSON on a deny, return the exit code. Malformed stdin fails
 * closed (deny). Injectable `readRaw` for tests.
 */
export async function runWriteProtection(
  _argv: string[] = [],
  deps: WriteProtectionDeps & { readRaw?: () => Promise<string> } = {},
): Promise<ExitCode> {
  let input: HookInput | null;
  try {
    const raw = deps.readRaw ? await deps.readRaw() : await readAllStdin();
    input = parseHookInput(raw);
  } catch {
    const decision = deny("malformed_hook_input", "write-protection: unparseable hook input");
    emitPermissionDecision(decision);
    return EXIT.ERROR;
  }
  const decision = decideWriteProtection(input, deps);
  emitPermissionDecision(decision);
  return decisionToExitCode(decision);
}

/** Read all of process.stdin as utf-8. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}
