/**
 * WS9 — holdout read-confinement enforcer (Δ Y).
 *
 * PreToolUse guard denying Read/Grep/Glob and ANY Bash command that references
 * the holdout answer-key store (`<dataDir>/runs/<run>/holdouts/**`), so the
 * holdout criteria are UNREADABLE from an implementer worktree. Defense-in-depth:
 * the data dir already lives OUTSIDE the repo (WS1) so in-repo Read tools cannot
 * reach it, but an implementer could shell at the absolute data-dir path — this guard
 * denies that, with absolute and `..`/symlink-traversal forms collapsing to the
 * same canonical deny. Bash denial is PATH-based (the holdouts path in argv), not a
 * reader-binary denylist: `python`/`node`/`dd`/`base64`/`cp` exfiltration is denied
 * just like `cat`, since any binary that opens the file leaks the key.
 *
 * Path matching reuses tcb.ts's canonicalization; the holdout-specific matcher
 * is narrower than the full TCB write-deny (it targets the holdouts subtree, the
 * answer key proper, rather than all of `runs/**`).
 */
import { EXIT, type ExitCode } from "../shared/exit-codes.js";
import { sep } from "node:path";
import { resolveDataDir, type DataDirOptions } from "../config/load.js";
import { createLogger } from "../shared/index.js";
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

const log = createLogger("holdout-guard");

/** In-repo read tools that take a `file_path`/`path`/`pattern`. */
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

/**
 * Known file-reader binaries. NO LONGER a gate — Bash denial is path-based — kept
 * as an OPTIONAL signal: a recognized reader alongside a holdouts path is a stronger
 * exfiltration tell, noted in the BASH deny reason only (the `viaReader` suffix at
 * the Bash branch below). The Read/Grep/Glob deny path is a structured-tool match
 * and carries no such suffix.
 */
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
  } catch (err) {
    // resolveDataDir throws ONLY when CLAUDE_PLUGIN_DATA is unset — i.e. no holdout
    // store exists, so allowing is SAFE: there is nothing for the Bash textual
    // race-catch arm to protect. The canonical-path arm still applies. But surface
    // it LOUDLY rather than swallow: the textual arm is now inert, and any
    // UNEXPECTED resolver failure must be detectable, not silent.
    dataDir = undefined;
    log.warn(
      `holdout store dir unresolved (${(err as Error).message}); ` +
        `the Bash textual-match arm is inert (no store configured) — canonical-path denial still applies`,
    );
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

  // Bash: PATH-based denial, binary-agnostic. We do NOT gate on a reader-binary
  // denylist — that let any other binary that opens a file (python -c open().read(),
  // node -e readFileSync, dd if=, base64, cp, tar, …) exfiltrate the answer key
  // untouched. Instead scan EVERY path token of ANY command and deny if it reaches
  // the holdouts subtree. The reader list survives only as an OPTIONAL signal recorded
  // into the deny reason (a recognized reader is a stronger exfiltration tell).
  if (tool === "Bash") {
    const cmd = commandOf(input);
    if (cmd.length === 0) return allow();
    const viaReader = READ_COMMAND_RE.test(cmd) ? " via a reader command" : "";
    for (const tokRaw of bashPathTokens(cmd)) {
      const tok = tokRaw.replace(/^["']|["']$/g, "");
      // Cheap pre-filter: only canonicalize tokens that could be paths.
      if (!tok.includes("holdouts") && !tok.includes("/") && !tok.includes("..")) continue;
      const canonical = canonicalizePath(tok, cwd);
      // Deny on the canonical landing in a holdouts subtree, OR the raw token
      // textually embedding the absolute data-dir holdouts path (catches a
      // create-then-read race / non-existent leaf that does not resolve on disk).
      const reachesHoldout =
        isHoldoutPath(canonical) ||
        Boolean(dataDir && tok.includes("holdouts") && tok.includes(dataDir));
      if (reachesHoldout) {
        const target = isHoldoutPath(canonical) ? canonical : tok;
        return deny(
          "holdout_read_denied",
          `Bash command referencing the holdout answer-key store ('${target}')${viaReader} is forbidden (Δ Y)`,
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
