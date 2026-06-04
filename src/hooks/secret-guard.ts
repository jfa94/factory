/**
 * WS9 — PreToolUse Bash guard: block `git commit`/`git push` whose staged or
 * unpushed diff contains a known provider-secret shape (Δ B).
 *
 * Ports `hooks/secret-commit-guard.sh` onto the typed seam:
 *   - detects `git commit` / `git push` (incl. fused override forms);
 *   - DENIES git-dir/work-tree override bypass forms FAIL-CLOSED (an override
 *     could redirect the scan to a different repo than the one committed);
 *   - resolves the target repo (honors `git -C <dir>`); a non-git target fails
 *     CLOSED;
 *   - scans the staged (`git diff --cached`) or unpushed (`git log -p`) diff via
 *     the INJECTABLE exec seam and runs {@link detectSecrets} +
 *     {@link SECRET_REDACTION_PATTERNS} over it plus a path blocklist;
 *   - denies the nested-shell/hook-bypass forms while autonomous.
 *
 * git is reached ONLY through the injected exec seam, so units run without git.
 */
import { EXIT, type ExitCode } from "../cli/exit-codes.js";
import { exec as defaultExec, type ExecResult } from "../shared/exec.js";
import { detectSecrets } from "../shared/secret-patterns.js";
import { isNestedShellOrHookBypass } from "./shell-bypass.js";
import {
  allow,
  commandOf,
  deny,
  decisionToExitCode,
  emitPermissionDecision,
  parseHookInput,
  type HookDecision,
  type HookInput,
} from "./hook-io.js";

/** Path-name blocklist (basenames/globs that must never be committed). */
const PATH_BLOCKLIST: ReadonlyArray<RegExp> = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.pem$/,
  /\.key$/,
  /^id_(rsa|ed25519|ecdsa|dsa)/,
  /^credentials\.(json|ya?ml)$/,
  /\.(keystore|p12|pfx|jks)$/,
  /^service-account.*\.json$/,
  /^\.netrc$/,
  /\.crt$/,
  /\.(tfvars|tfstate)$/,
  /^kubeconfig$/,
  /^firebase-adminsdk-.*\.json$/,
  /\.kdbx$/,
  /^wrangler\.toml$/,
  /\.(gpg|asc|ppk)$/,
];

/** A minimal exec signature (so callers/tests inject a fake). */
export type ExecFn = (
  command: string,
  args?: readonly string[],
  opts?: { cwd?: string },
) => Promise<ExecResult>;

/** Options for {@link decideSecretGuard} (injectable). */
export interface SecretGuardDeps {
  exec?: ExecFn;
  cwd?: string;
  autonomousMode?: boolean;
}

/** Word-anchored `git … commit` detector (paired global flags tolerated). */
const GIT_COMMIT_RE = /(^|[\s&;])git(\s+-[^\s]+\s+[^\s]+)*\s+commit(\s|$)/;
const GIT_PUSH_RE = /(^|[\s&;])git(\s+-[^\s]+\s+[^\s]+)*\s+push(\s|$)/;
/** Looser detector (any flags) used to catch fused-override commit/push. */
const GIT_SUBCMD_LOOSE_RE = /(^|[\s&;])git(\s+[^\s]+)*\s+(commit|push)(\s|$)/;

/** git-dir / work-tree override bypass detectors (fail-closed deny). */
const GIT_DIR_FLAG_RE = /(^|\s)--git-dir(=|\s)/;
const WORK_TREE_FLAG_RE = /(^|\s)--work-tree(=|\s)/;
const GIT_ENV_OVERRIDE_RE = /^\s*([A-Z_][A-Z0-9_]*=[^\s]+\s+)*GIT_(DIR|WORK_TREE)=/;

/** Resolve the `-C <dir>` target repo from a git command (else cwd). */
function resolveCommitDir(command: string, cwd: string): string {
  const m = command.match(/git\s+-C\s+([^\s]+)/);
  return m ? m[1]! : cwd;
}

/** Parse a redaction-safe preview of a matched secret token. */
function redactPreview(s: string): string {
  return `${s.slice(0, 4)}****`;
}

/**
 * Decide whether a git commit/push must be blocked for staging a secret.
 * Returns allow for non-commit/push commands. Uses the injected exec seam to
 * read the diff; a git failure or non-git target fails CLOSED (deny).
 */
export async function decideSecretGuard(
  input: HookInput | null,
  deps: SecretGuardDeps = {},
): Promise<HookDecision> {
  const command = commandOf(input);
  if (command.length === 0) return allow();

  const cwd = deps.cwd ?? process.cwd();
  const autonomousMode = deps.autonomousMode ?? process.env.FACTORY_AUTONOMOUS_MODE === "1";
  const execFn = deps.exec ?? defaultExec;

  if (autonomousMode && isNestedShellOrHookBypass(command)) {
    return deny(
      "nested_shell_denied",
      `nested-shell or hook-bypass not allowed in autonomous mode: ${command}`,
    );
  }

  const isCommit = GIT_COMMIT_RE.test(command);
  const isPush = GIT_PUSH_RE.test(command);

  // Neither commit nor push under the strict detector: only proceed if a fused
  // override form names commit/push (so we can deny the bypass), else allow.
  if (!isCommit && !isPush) {
    if (!GIT_SUBCMD_LOOSE_RE.test(command)) return allow();
  }

  // --- Deny git-dir/work-tree override bypass (fail-closed) ---
  if (
    GIT_DIR_FLAG_RE.test(command) ||
    WORK_TREE_FLAG_RE.test(command) ||
    GIT_ENV_OVERRIDE_RE.test(command)
  ) {
    return deny("git_dir_override_denied", `git-dir/work-tree override blocked: ${command}`);
  }

  const commitDir = resolveCommitDir(command, cwd);

  // Confirm the target is a git repo; non-git → fail closed.
  let repoCheck: ExecResult;
  try {
    repoCheck = await execFn("git", ["-C", commitDir, "rev-parse", "--git-dir"], {});
  } catch {
    return deny(
      "non_git_target",
      `secret-commit-guard: cannot scan, '${commitDir}' is not a git repository`,
    );
  }
  if (repoCheck.code !== 0) {
    return deny(
      "non_git_target",
      `secret-commit-guard: cannot scan, '${commitDir}' is not a git repository`,
    );
  }

  // --- Gather scan paths + diff ---
  let scanPaths = "";
  let scanDiff = "";
  if (isCommit) {
    let names: ExecResult;
    let diff: ExecResult;
    try {
      names = await execFn("git", ["-C", commitDir, "diff", "--cached", "--name-only"], {});
      diff = await execFn("git", ["-C", commitDir, "diff", "--cached", "-U0"], {});
    } catch {
      return deny(
        "git_diff_failed",
        "secret-commit-guard: git diff failed — cannot verify staged changes",
      );
    }
    if (names.code !== 0 || diff.code !== 0) {
      return deny(
        "git_diff_failed",
        "secret-commit-guard: git diff failed — cannot verify staged changes",
      );
    }
    scanPaths = names.stdout;
    scanDiff = diff.stdout;
  } else {
    // Push: scan unpushed commits (upstream..HEAD, else all of HEAD).
    let log: ExecResult;
    let names: ExecResult;
    try {
      names = await execFn(
        "git",
        ["-C", commitDir, "log", "@{upstream}..HEAD", "--name-only", "--format="],
        {},
      );
      log = await execFn("git", ["-C", commitDir, "log", "-p", "@{upstream}..HEAD", "-U0"], {});
    } catch {
      return deny(
        "git_log_failed",
        "secret-commit-guard: git log failed — cannot verify pushed commits",
      );
    }
    if (names.code !== 0 || log.code !== 0) {
      // No upstream is a legitimate first-push, not a malfunction: retry the full
      // HEAD range. If THAT also fails, fail closed.
      try {
        names = await execFn(
          "git",
          ["-C", commitDir, "log", "HEAD", "--name-only", "--format="],
          {},
        );
        log = await execFn("git", ["-C", commitDir, "log", "-p", "HEAD", "-U0"], {});
      } catch {
        return deny(
          "git_log_failed",
          "secret-commit-guard: git log failed — cannot verify pushed commits",
        );
      }
      if (names.code !== 0 || log.code !== 0) {
        return deny(
          "git_log_failed",
          "secret-commit-guard: git log failed — cannot verify pushed commits",
        );
      }
    }
    scanPaths = names.stdout;
    scanDiff = log.stdout;
  }

  const blocks: string[] = [];

  // --- Path-name scan ---
  for (const raw of scanPaths.split("\n")) {
    const fpath = raw.trim();
    if (fpath.length === 0) continue;
    const base = fpath.split("/").pop() ?? fpath;
    for (const glob of PATH_BLOCKLIST) {
      if (glob.test(base) || glob.test(fpath)) {
        blocks.push(`path:${fpath}`);
        break;
      }
    }
  }

  // --- Content scan (detectSecrets over the diff) ---
  if (scanDiff.length > 0) {
    const hits = detectSecrets(scanDiff);
    for (const name of hits) {
      blocks.push(`content:${name}`);
    }
  }

  if (blocks.length > 0) {
    return deny("secret_detected", blocks.join(", "));
  }
  return allow();
}

/**
 * Run the secret guard end-to-end. Malformed stdin fails closed (deny).
 * Injectable `readRaw` for tests.
 */
export async function runSecretGuard(
  _argv: string[] = [],
  deps: SecretGuardDeps & { readRaw?: () => Promise<string> } = {},
): Promise<ExitCode> {
  let input: HookInput | null;
  try {
    const raw = deps.readRaw ? await deps.readRaw() : await readAllStdin();
    input = parseHookInput(raw);
  } catch {
    const decision = deny("malformed_hook_input", "secret-guard: unparseable hook input");
    emitPermissionDecision(decision);
    return EXIT.ERROR;
  }
  const decision = await decideSecretGuard(input, deps);
  emitPermissionDecision(decision);
  return decisionToExitCode(decision);
}

/** redact preview kept exported for the deny-detail tests. */
export { redactPreview };

/** Read all of process.stdin as utf-8. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}
