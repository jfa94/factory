/**
 * WS9 — holdout read-confinement enforcer (Δ Y).
 *
 * PreToolUse guard denying Read/Grep/Glob and Bash-read (cat/grep/less/head/…)
 * of the holdout answer-key store (`<dataDir>/runs/<run>/holdouts/**`), so the
 * holdout criteria are UNREADABLE from an executor worktree. Defense-in-depth:
 * the data dir already lives OUTSIDE the repo (WS1) so in-repo Read tools cannot
 * reach it, but an executor could shell a `cat` at the absolute data-dir path —
 * this guard denies that, with absolute and `..`/symlink-traversal forms
 * collapsing to the same canonical deny.
 *
 * Path matching reuses tcb.ts's canonicalization; the holdout-specific matcher
 * is narrower than the full TCB write-deny (it targets the holdouts subtree, the
 * answer key proper, rather than all of `runs/**`).
 */
import { EXIT, type ExitCode } from "../cli/exit-codes.js";
import { sep } from "node:path";
import { resolveDataDir, type DataDirOptions } from "../config/load.js";
import { canonicalizePath } from "./tcb.js";
import {
  allow,
  commandOf,
  deny,
  decisionToExitCode,
  emitPermissionDecision,
  parseHookInput,
  toolNameOf,
  type HookDecision,
  type HookInput,
} from "./hook-io.js";

/** In-repo read tools that take a `file_path`/`path`/`pattern`. */
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

/** Bash read commands that could exfiltrate file contents. */
const READ_COMMAND_RE =
  /\b(cat|less|more|head|tail|grep|egrep|fgrep|rg|sed|awk|od|xxd|hexdump|strings|nl|tac|cut|sort|uniq|jq|yq)\b/;

/** Options for the holdout guard (injectable). */
export interface HoldoutGuardDeps extends DataDirOptions {
  /** cwd for path canonicalization. */
  cwd?: string;
}

/** Does a canonical absolute path sit under any `**​/holdouts/**` segment? */
function isHoldoutPath(canonical: string): boolean {
  return canonical.split(sep).includes("holdouts");
}

/** Extract candidate read targets (path/pattern) from a non-Bash read tool. */
function readTargetsOf(input: HookInput | null): string[] {
  const ti = (input?.tool_input ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["file_path", "path", "pattern", "glob"]) {
    const v = ti[key];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

/** Extract path-like tokens from a Bash command (whitespace tokens). */
function bashPathTokens(cmd: string): string[] {
  return cmd
    .split(/[\s;|&><]+/)
    .filter((t) => t.length > 0)
    .filter((t) => !t.startsWith("-"));
}

/**
 * Decide whether a read invocation must be blocked for reaching the holdout
 * store. Covers Read/Grep/Glob (path/pattern args) and Bash read commands
 * (cat/grep/… of an absolute or traversal path that resolves into `holdouts/`).
 */
export function decideHoldoutGuard(
  input: HookInput | null,
  deps: HoldoutGuardDeps = {},
): HookDecision {
  const cwd = deps.cwd ?? process.cwd();
  let dataDir: string | undefined;
  try {
    dataDir = resolveDataDir(deps);
  } catch {
    dataDir = undefined;
  }

  const tool = toolNameOf(input);

  // In-repo read tools: check each path/pattern arg.
  if (READ_TOOLS.has(tool)) {
    for (const t of readTargetsOf(input)) {
      const canonical = canonicalizePath(t, cwd);
      if (isHoldoutPath(canonical)) {
        return deny(
          "holdout_read_denied",
          `${tool} of the holdout answer-key store ('${canonical}') is forbidden (Δ Y)`,
        );
      }
    }
    return allow();
  }

  // Bash: only inspect read-shaped commands; scan path tokens.
  if (tool === "Bash") {
    const cmd = commandOf(input);
    if (cmd.length === 0) return allow();
    if (!READ_COMMAND_RE.test(cmd)) return allow();
    for (const tokRaw of bashPathTokens(cmd)) {
      const tok = tokRaw.replace(/^["']|["']$/g, "");
      // Cheap pre-filter: only canonicalize tokens that could be paths.
      if (!tok.includes("holdouts") && !tok.includes("/") && !tok.includes("..")) continue;
      const canonical = canonicalizePath(tok, cwd);
      if (isHoldoutPath(canonical)) {
        return deny(
          "holdout_read_denied",
          `Bash read of the holdout answer-key store ('${canonical}') is forbidden (Δ Y)`,
        );
      }
      // Also catch an absolute data-dir holdouts path even if the token did not
      // resolve on disk (a create-then-read race / non-existent leaf).
      if (dataDir && tok.includes("holdouts") && tok.includes(dataDir)) {
        return deny(
          "holdout_read_denied",
          `Bash read of the holdout answer-key store ('${tok}') is forbidden (Δ Y)`,
        );
      }
    }
    return allow();
  }

  return allow();
}

/**
 * Run the holdout guard end-to-end. Malformed stdin fails closed (deny).
 * Injectable `readRaw` for tests.
 */
export async function runHoldoutGuard(
  _argv: string[] = [],
  deps: HoldoutGuardDeps & { readRaw?: () => Promise<string> } = {},
): Promise<ExitCode> {
  let input: HookInput | null;
  try {
    const raw = deps.readRaw ? await deps.readRaw() : await readAllStdin();
    input = parseHookInput(raw);
  } catch {
    const decision = deny("malformed_hook_input", "holdout-guard: unparseable hook input");
    emitPermissionDecision(decision);
    return EXIT.ERROR;
  }
  const decision = decideHoldoutGuard(input, deps);
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
