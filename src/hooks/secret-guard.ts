/**
 * WS9 — PreToolUse Bash guard: block `git commit`/`git push` whose staged or
 * unpushed diff contains a known provider-secret shape (Δ B).
 *
 * Ports `hooks/secret-commit-guard.sh` onto the typed seam:
 *   - detects `git commit` / `git push` (incl. fused override forms);
 *   - DENIES, FAIL-CLOSED, the redirection bypasses that decouple the scanned
 *     index/repo from the one actually committed: the `--git-dir`/`--work-tree`
 *     FLAGS and the index/repo-redirecting ENV family (GIT_DIR, GIT_WORK_TREE,
 *     GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES,
 *     GIT_COMMON_DIR, GIT_NAMESPACE — see {@link REDIRECT_ENV}). Benign GIT_*
 *     (GIT_SSH_COMMAND, GIT_AUTHOR_*, GIT_EDITOR, …) are NOT denied: this guard
 *     fires on EVERY Bash (not only autonomous), so a human's
 *     `GIT_SSH_COMMAND=… git push` must not false-positive;
 *   - resolves the target repo via the canonical {@link parseGitInvocation} parser
 *     with LAST-WINS `git -C <dir>` (a first-match scan let
 *     `git -C <clean> -C <secret> commit` evade it); a non-git target fails CLOSED;
 *   - scans the staged (`git diff --cached`) or unpushed (`git log -p`) diff via
 *     the INJECTABLE exec seam and runs {@link detectSecrets} +
 *     {@link SECRET_REDACTION_PATTERNS} over it plus a path blocklist;
 *   - denies the nested-shell/hook-bypass forms while autonomous.
 *
 * git is reached ONLY through the injected exec seam, so units run without git.
 */
import { EXIT, type ExitCode } from "../shared/exit-codes.js";
import { exec as defaultExec, type ExecResult } from "../shared/exec.js";
import { detectSecrets } from "../shared/secret-patterns.js";
import { isNestedShellOrHookBypass } from "./shell-bypass.js";
import { parseGitInvocation, type GitInvocation } from "./git-args.js";
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

/**
 * Env files that are committed by convention (placeholders / public dev config).
 * Skipped by the PATH blocklist; their CONTENT is still scanned, so a real
 * provider key inside one is still blocked.
 * ponytail: fixed safe set; add suffixes here if a project needs more.
 */
const ENV_COMMITTABLE = /^\.env\.(example|sample|template|test)$/;

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

/**
 * Token-aware commit/push detection. Substring regexes mis-fired on the word
 * `commit`/`push` anywhere in the string (even inside an `echo` arg or across a
 * `&&`), so a read-only `… && echo "commit needed"` was scanned as a push. We
 * instead split into coarse segments and parse each with {@link parseGitInvocation}:
 * a segment counts as commit/push only when that is its real git subcommand. This
 * keeps detection of a commit/push in a LATER chained segment (`git status && git
 * commit`) that a whole-command first-git parse would miss.
 *
 * The splitter breaks on sequencing operators (`&&`, `||`, `;`, lone `&`, `|`,
 * newline) AND command-substitution/backtick boundaries (`$(`, `` ` ``, `)`), so a
 * `git commit` hidden in `$(…)`, after a background `&`, or inside backticks lands
 * in its own segment. Segments are DETECTION-ONLY and never semantically
 * authoritative: over-splitting is fine (a fragment still re-parses to its
 * subcommand), under-splitting is the only failure that matters — so it fails
 * CLOSED. The redirect/flag denies below additionally scan the whole `command`.
 *
 * A value-taking global (`git --namespace x commit`) makes the parser read the
 * value as the subcommand, so a per-segment backstop also treats a segment as
 * commit/push when it carries a `git` binary plus a later bare `commit`/`push`
 * token the parser could not classify. Over-detection there is acceptable; a miss
 * is a guard bypass.
 */
function findGitCommitOrPush(command: string): { isCommit: boolean; inv: GitInvocation } | null {
  for (const seg of command.split(/&&|\|\||;|&|\||\n|\$\(|`|\)/)) {
    const inv = parseGitInvocation(seg);
    // ponytail: `subcommand` is an open string, so a typo in these "commit"/"push"
    // literals would fail OPEN. Left as-is: subcommand can be any git verb (no closed
    // union to narrow to) and a shared const wouldn't make a typo a compile error;
    // the literals are covered by the deny tests, and the backstop below + the
    // whole-command redirect denies fail closed around it.
    if (inv.subcommand === "commit") return { isCommit: true, inv };
    if (inv.subcommand === "push") return { isCommit: false, inv };
    const tokens = seg.split(/\s+/).filter((t) => t.length > 0);
    const gitAt = tokens.findIndex((t) => (t.split("/").pop() ?? t) === "git");
    if (gitAt >= 0) {
      const rest = tokens.slice(gitAt + 1);
      if (rest.includes("commit")) return { isCommit: true, inv };
      if (rest.includes("push")) return { isCommit: false, inv };
    }
  }
  return null;
}

/** git-dir / work-tree override FLAG detectors (fail-closed deny). */
const GIT_DIR_FLAG_RE = /(^|\s)--git-dir(=|\s)/;
const WORK_TREE_FLAG_RE = /(^|\s)--work-tree(=|\s)/;

/**
 * The git env vars that DECOUPLE the scanned index/repo from the one actually
 * committed — the root-cause set the guard denies fail-closed. A commit under any
 * of these reads a different index/object store than `git diff --cached` scans, so
 * a staged secret would slip past. NOT a blanket GIT_* deny: benign vars
 * (GIT_SSH_COMMAND, GIT_AUTHOR_* and GIT_COMMITTER_*, GIT_EDITOR, GIT_PAGER, …)
 * are allowed so a human's `GIT_SSH_COMMAND=… git push` is not a false positive
 * (the guard runs on EVERY Bash, not only autonomous runs).
 */
const REDIRECT_ENV: ReadonlySet<string> = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
]);

/**
 * Run a sequence of git exec calls FAIL-CLOSED. Returns the results only if every
 * call resolves AND exits 0; on any throw or non-zero exit returns a deny
 * {@link HookDecision} carrying `reason`/`msg`. Each argv is prefixed with
 * `-C <cwd>`. This is the guard's fail-closed-DENY exec contract — deliberately
 * the OPPOSITE of `shared/exec`'s throw-on-non-zero — and collapses the four
 * byte-identical exec→catch→deny blocks (repo check, commit diff, push log, and
 * the push-retry log) into one. Callers branch on `Array.isArray`.
 */
async function execOrDeny(
  execFn: ExecFn,
  cwd: string,
  argvs: readonly (readonly string[])[],
  reason: string,
  msg: string,
): Promise<ExecResult[] | HookDecision> {
  const results: ExecResult[] = [];
  try {
    for (const argv of argvs) {
      results.push(await execFn("git", ["-C", cwd, ...argv], {}));
    }
  } catch {
    return deny(reason, msg);
  }
  if (results.some((r) => r.code !== 0)) return deny(reason, msg);
  return results;
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

  const match = findGitCommitOrPush(command);
  if (!match) return allow();
  // `inv` is the parse of the MATCHED commit/push segment, so the work-dir
  // resolution below reflects the segment git actually operates on, not a
  // whole-command first-git scan. The redirect-env deny (b), by contrast, scans
  // the WHOLE command: a redirect var exported in a PRIOR segment
  // (`export GIT_INDEX_FILE=… && git commit`) is still in scope for the chained
  // git process, so segment-scoping it would fail OPEN.
  const { isCommit, inv } = match;

  // --- Deny redirection bypasses (fail-closed) ---
  // (a) --git-dir / --work-tree FLAGS. Kept as loose regexes: the parser captures a
  //     single git-dir and does not retain work-tree, so the regex scan is broader.
  if (GIT_DIR_FLAG_RE.test(command) || WORK_TREE_FLAG_RE.test(command)) {
    return deny("git_dir_override_denied", `git-dir/work-tree override blocked: ${command}`);
  }
  // (b) ENV-prefix overrides in the index/repo-redirection family (GIT_INDEX_FILE,
  //     GIT_DIR, …). These point the commit at a different index/store than the
  //     scan reads. Benign GIT_* are intentionally NOT denied (see REDIRECT_ENV).
  const redirectEnv = parseGitInvocation(command).envNames.filter((name) => REDIRECT_ENV.has(name));
  if (redirectEnv.length > 0) {
    return deny(
      "git_redirect_env_denied",
      `git index/repo-redirecting env override blocked (${redirectEnv.join(", ")}): ${command}`,
    );
  }

  // Resolve the target repo with LAST-WINS `-C <dir>` (matches branch-protection);
  // a first-match scan let `git -C <clean> -C <secret> commit` evade the guard.
  const commitDir = inv.workDir.length > 0 ? inv.workDir : cwd;

  // Confirm the target is a git repo; non-git → fail closed.
  const repo = await execOrDeny(
    execFn,
    commitDir,
    [["rev-parse", "--git-dir"]],
    "non_git_target",
    `secret-commit-guard: cannot scan, '${commitDir}' is not a git repository`,
  );
  if (!Array.isArray(repo)) return repo;

  // --- Gather scan paths + diff ---
  let scanPaths = "";
  let scanDiff = "";
  if (isCommit) {
    const res = await execOrDeny(
      execFn,
      commitDir,
      [
        ["diff", "--cached", "--name-only"],
        ["diff", "--cached", "-U0"],
      ],
      "git_diff_failed",
      "secret-commit-guard: git diff failed — cannot verify staged changes",
    );
    if (!Array.isArray(res)) return res;
    scanPaths = res[0]!.stdout;
    scanDiff = res[1]!.stdout;
  } else {
    // Push: scan unpushed commits (`@{upstream}..HEAD`). No upstream is a
    // legitimate first-push, not a malfunction, so on failure retry the full HEAD
    // range; if THAT also fails, fail closed. (A spawn-level throw recurs on the
    // retry with the same binary, so it still lands on the same deny — only a
    // non-zero exit, the real no-upstream signal, is genuinely recoverable.)
    const logFailed = "secret-commit-guard: git log failed — cannot verify pushed commits";
    let res = await execOrDeny(
      execFn,
      commitDir,
      [
        ["log", "@{upstream}..HEAD", "--name-only", "--format="],
        ["log", "-p", "@{upstream}..HEAD", "-U0"],
      ],
      "git_log_failed",
      logFailed,
    );
    if (!Array.isArray(res)) {
      res = await execOrDeny(
        execFn,
        commitDir,
        [
          ["log", "HEAD", "--name-only", "--format="],
          ["log", "-p", "HEAD", "-U0"],
        ],
        "git_log_failed",
        logFailed,
      );
      if (!Array.isArray(res)) return res;
    }
    scanPaths = res[0]!.stdout;
    scanDiff = res[1]!.stdout;
  }

  const blocks: string[] = [];

  // --- Path-name scan ---
  for (const raw of scanPaths.split("\n")) {
    const fpath = raw.trim();
    if (fpath.length === 0) continue;
    const base = fpath.split("/").pop() ?? fpath;
    // Conventionally-committed env files (.env.example/.test/etc.) are skipped
    // by the path blocklist; their content is still scanned below.
    if (ENV_COMMITTABLE.test(base)) continue;
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

/** Read all of process.stdin as utf-8. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}
