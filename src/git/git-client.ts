/**
 * WS3 — typed GitClient over an injectable {@link GitRunner}.
 *
 * The narrow git surface the rest of WS3 needs. Two flavours of call:
 *   - FATAL git ops (fetch, checkout -B, push) go through `runOrThrow` so a
 *     failure aborts loudly.
 *   - PROBE git ops where a non-zero exit is a legitimate ANSWER (show-ref miss,
 *     rev-parse of a maybe-absent ref) branch on `ExecResult.code` instead.
 *
 * By CONSTRUCTION there is NO force-push method (global rule: never force-push in
 * any form). The interface simply does not expose one, so no caller can reach it.
 */
import type { ExecOptions } from "../shared/index.js";
import { createLogger } from "../shared/index.js";
import { defaultGitRunner, runOrThrow, type GitRunner } from "./exec-tools.js";

const log = createLogger("git");

/** Per-call git options: which worktree/repo dir to run in. */
export interface GitOpts {
  /** Working directory (worktree path). Defaults to the process cwd. */
  cwd?: string;
}

/** Options for {@link GitClient.push}. */
export interface PushOptions extends GitOpts {
  /** Set the upstream tracking ref (`-u`). */
  setUpstream?: boolean;
}

/** Options for {@link GitClient.mergeFfOrCommit}. */
export type MergeOptions = GitOpts;

/**
 * The typed git surface WS3 builds on. NO force-push exists here by design.
 */
export interface GitClient {
  /** `git fetch <remote> <ref>` — fatal on failure. */
  fetch(remote: string, ref: string, opts?: GitOpts): Promise<void>;
  /** `git rev-parse <ref>` → trimmed sha. Fatal if the ref does not resolve. */
  revParse(ref: string, opts?: GitOpts): Promise<string>;
  /** True iff `git show-ref --verify <ref>` succeeds (a miss is a normal NO). */
  branchExists(ref: string, opts?: GitOpts): Promise<boolean>;
  /**
   * True iff `ref` resolves to a commit (`git rev-parse --verify --quiet <ref>`).
   * Generic over heads, remote-tracking refs, tags, and raw shas (unlike
   * {@link branchExists}, which is `refs/heads/`-scoped). A non-zero exit is the
   * ANSWER (ref absent); only a deeper failure throws. Used by rescue's read-only
   * recoverable-work probe to test a maybe-deleted base/branch before counting.
   */
  refExists(ref: string, opts?: GitOpts): Promise<boolean>;
  /**
   * Count commits reachable from `branch` but not `base`
   * (`git rev-list --count <base>..<branch>`). Both refs must resolve — guard with
   * {@link refExists}; fatal otherwise. Read-only; used by rescue to report how much
   * committed work a non-shipped task branch carries above the run's staging base.
   */
  commitsAhead(base: string, branch: string, opts?: GitOpts): Promise<number>;
  /**
   * `git checkout -B <branch> <startPoint>` — the D12 idempotent re-point.
   * Creates-or-resets `branch` onto `startPoint`. Fatal on failure.
   */
  checkoutB(branch: string, startPoint: string, opts?: GitOpts): Promise<void>;
  /** `git rev-parse --abbrev-ref HEAD` → current branch name. */
  currentBranch(opts?: GitOpts): Promise<string>;
  /**
   * `git remote get-url <remote>` → the remote URL, or `null` when the remote is
   * absent / the dir is not a git repo (a non-zero exit is a normal NO — used to
   * auto-derive `--repo`, where "no origin" is a legitimate answer, not an error).
   */
  remoteUrl(remote: string, opts?: GitOpts): Promise<string | null>;
  /**
   * `git ls-remote --heads <remote> <branch>` → sha if the remote branch exists,
   * else null (a missing remote branch is a normal answer, not an error).
   */
  lsRemoteHeads(remote: string, branch: string, opts?: GitOpts): Promise<string | null>;
  /** `git merge-base <a> <b>` → trimmed sha. Fatal if no merge base. */
  mergeBase(a: string, b: string, opts?: GitOpts): Promise<string>;
  /** `git worktree add ...` — fatal on failure. */
  worktreeAdd(args: readonly string[], opts?: GitOpts): Promise<void>;
  /**
   * True iff `path` is a registered worktree (`git worktree list --porcelain`
   * lists a `worktree <path>` line). Makes task-worktree creation REPLAY-SAFE: a
   * resume after a mid-preflight failure reuses the existing worktree instead of
   * fataling on `worktree add`.
   */
  worktreeExists(path: string, opts?: GitOpts): Promise<boolean>;
  /** `git worktree remove ...` — returns the raw exit code (caller may retry). */
  worktreeRemove(args: readonly string[], opts?: GitOpts): Promise<number | null>;
  /** `git push [-u] <remote> <branch>` — fatal on failure. NO force flag. */
  push(remote: string, branch: string, opts?: PushOptions): Promise<void>;
  /**
   * Check out `branch` from its origin tracking ref, then `git merge --no-edit <ref>`.
   * Fast-forwards when possible; else makes a merge commit. FATAL on a merge conflict
   * (non-auto-recoverable → surfaces for rescue). NEVER uses `--force` or `-f`.
   */
  mergeFfOrCommit(branch: string, ref: string, opts?: MergeOptions): Promise<void>;
  /**
   * `git reset --hard <ref>` then `git clean -fd` — restore the worktree to `ref`,
   * discarding every commit/staged/unstaged change above it AND untracked (NON-ignored)
   * files. The coroutine's idempotent re-spawn uses this to discard an abandoned
   * producer's partial work before re-spawning at the same (phase, rung).
   *
   * `-fd` (NOT `-fdx`) deliberately preserves IGNORED files so the provisioned deps
   * (node_modules, build caches) survive the reset. This is a LOCAL worktree op on a
   * local-until-ship task branch — NOT a history rewrite of a pushed ref, so it does
   * NOT breach the no-force-push rule (cf. {@link import("./worktree.js").removeWorktree}'s
   * teardown `--force`). Fatal on failure.
   */
  resetHardClean(ref: string, opts?: GitOpts): Promise<void>;
}

/** Default GitClient over the real (or an injected) git runner. */
export class DefaultGitClient implements GitClient {
  private readonly runner: GitRunner;

  constructor(runner: GitRunner = defaultGitRunner) {
    this.runner = runner;
  }

  private exec(args: readonly string[], opts?: GitOpts) {
    const execOpts: ExecOptions = opts?.cwd ? { cwd: opts.cwd } : {};
    return this.runner(args, execOpts);
  }

  private execOrThrow(args: readonly string[], opts?: GitOpts) {
    const execOpts: ExecOptions = opts?.cwd ? { cwd: opts.cwd } : {};
    return runOrThrow("git", this.runner, args, execOpts);
  }

  async fetch(remote: string, ref: string, opts?: GitOpts): Promise<void> {
    await this.execOrThrow(["fetch", remote, ref], opts);
  }

  async revParse(ref: string, opts?: GitOpts): Promise<string> {
    const r = await this.execOrThrow(["rev-parse", ref], opts);
    return r.stdout.trim();
  }

  async branchExists(ref: string, opts?: GitOpts): Promise<boolean> {
    // show-ref --verify --quiet exits 1 (no output) when the ref is absent —
    // that is the ANSWER, not an error. Only a >1 code is a real failure.
    const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
    const r = await this.exec(["show-ref", "--verify", "--quiet", fullRef], opts);
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw new Error(`git show-ref failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
  }

  async refExists(ref: string, opts?: GitOpts): Promise<boolean> {
    // rev-parse --verify --quiet prints the sha & exits 0 when `ref` resolves,
    // else exits 1 with no output — that 1 is the ANSWER (absent), not an error.
    const r = await this.exec(["rev-parse", "--verify", "--quiet", ref], opts);
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw new Error(`git rev-parse failed (code=${r.code ?? "null"}): ${r.stderr.trim()}`);
  }

  async commitsAhead(base: string, branch: string, opts?: GitOpts): Promise<number> {
    const r = await this.execOrThrow(["rev-list", "--count", `${base}..${branch}`], opts);
    const n = Number.parseInt(r.stdout.trim(), 10);
    if (!Number.isFinite(n)) {
      throw new Error(
        `git rev-list --count returned non-numeric output: ${JSON.stringify(r.stdout)}`,
      );
    }
    return n;
  }

  async checkoutB(branch: string, startPoint: string, opts?: GitOpts): Promise<void> {
    log.debug(`checkout -B ${branch} ${startPoint}`);
    await this.execOrThrow(["checkout", "-B", branch, startPoint], opts);
  }

  async currentBranch(opts?: GitOpts): Promise<string> {
    const r = await this.execOrThrow(["rev-parse", "--abbrev-ref", "HEAD"], opts);
    return r.stdout.trim();
  }

  async remoteUrl(remote: string, opts?: GitOpts): Promise<string | null> {
    // A non-zero exit (no such remote / not a git repo) is the ANSWER, not an
    // error — auto-derive treats "no origin" as not-derivable, never a throw.
    const r = await this.exec(["remote", "get-url", remote], opts);
    if (r.code !== 0) return null;
    const url = r.stdout.trim();
    return url.length > 0 ? url : null;
  }

  async lsRemoteHeads(remote: string, branch: string, opts?: GitOpts): Promise<string | null> {
    const r = await this.execOrThrow(["ls-remote", "--heads", remote, branch], opts);
    const line = r.stdout.trim();
    if (line.length === 0) return null;
    // Output: "<sha>\trefs/heads/<branch>"
    const sha = line.split(/\s+/)[0];
    return sha && sha.length > 0 ? sha : null;
  }

  async mergeBase(a: string, b: string, opts?: GitOpts): Promise<string> {
    const r = await this.execOrThrow(["merge-base", a, b], opts);
    return r.stdout.trim();
  }

  async worktreeAdd(args: readonly string[], opts?: GitOpts): Promise<void> {
    await this.execOrThrow(["worktree", "add", ...args], opts);
  }

  async worktreeExists(path: string, opts?: GitOpts): Promise<boolean> {
    // `git worktree list --porcelain` emits one `worktree <abs-path>` line per
    // registered worktree. A non-zero exit means the dir is not a git repo at all
    // — a real error, so fail loud (execOrThrow) rather than masking it as absent.
    const r = await this.execOrThrow(["worktree", "list", "--porcelain"], opts);
    return r.stdout.split("\n").some((line) => line === `worktree ${path}`);
  }

  async worktreeRemove(args: readonly string[], opts?: GitOpts): Promise<number | null> {
    const r = await this.exec(["worktree", "remove", ...args], opts);
    return r.code;
  }

  async push(remote: string, branch: string, opts?: PushOptions): Promise<void> {
    const args = ["push"];
    if (opts?.setUpstream) args.push("-u");
    args.push(remote, branch);
    await this.execOrThrow(args, opts);
  }

  async mergeFfOrCommit(branch: string, ref: string, opts?: MergeOptions): Promise<void> {
    log.debug(`merge --no-edit ${ref} into ${branch}`);
    // Check out the branch from its origin tracking ref first, then merge.
    await this.execOrThrow(["checkout", branch], opts);
    await this.execOrThrow(["merge", "--no-edit", ref], opts);
  }

  async resetHardClean(ref: string, opts?: GitOpts): Promise<void> {
    log.debug(`reset --hard ${ref} && clean -fd`);
    await this.execOrThrow(["reset", "--hard", ref], opts);
    // `-fd` only (no `-x`): drop untracked source the producer added, but KEEP ignored
    // provisioned deps (node_modules) so the re-spawned producer is not left bare.
    await this.execOrThrow(["clean", "-fd"], opts);
  }
}
