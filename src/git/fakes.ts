/**
 * WS3 — exported in-memory fakes implementing GitClient / GhClient.
 *
 * These satisfy "mock seams via exported types/constructors, not by stubbing exec
 * or editing seam files". They model an in-memory repo (branches, worktrees, a PR
 * table keyed by head branch) so idempotent-create, serial-merge ordering, and
 * protection state are all SCRIPTABLE with zero real git/gh invocation. Every
 * WS3 unit test and downstream consumer (WS6/WS10/WS12) uses these fixtures.
 */
import type { GitClient, GitOpts, MergeOptions, PushOptions } from "./git-client.js";
import type {
  ChecksState,
  CreatedPr,
  GhClient,
  GhOpts,
  PrCreateArgs,
  PrListArgs,
  PrMergeOptions,
  ProtectionApiResult,
  ProtectionPutBody,
  PullRequest,
} from "./gh-client.js";

// ---------------------------------------------------------------------------
// FakeGitClient
// ---------------------------------------------------------------------------

interface FakeBranch {
  /** Synthetic sha for the branch tip. */
  sha: string;
}

/** Construction options for {@link FakeGitClient}. */
export interface FakeGitOptions {
  /** Seed remote branches: name → sha (e.g. {"staging": "sha-staging-1"}). */
  remoteHeads?: Record<string, string>;
  /** Seed local branches. */
  localBranches?: Record<string, FakeBranch>;
  /** Current branch HEAD points at. */
  currentBranch?: string;
}

/**
 * In-memory GitClient. Records every mutating call so tests can assert ordering
 * and — critically — that NO force-push path is ever taken (there is no such
 * method to call).
 */
export class FakeGitClient implements GitClient {
  /** remote name → (branch → sha). */
  readonly remotes = new Map<string, Map<string, string>>();
  /** local branch name → tip sha. */
  readonly localBranches = new Map<string, string>();
  /** worktree path → branch checked out there. */
  readonly worktrees = new Map<string, string>();
  /** remote name → configured remote URL (for `remoteUrl` / `--repo` auto-derive). */
  readonly remoteUrls = new Map<string, string>();
  /** When true, `remoteUrl` reports a miss (simulate a non-git dir / no remote). */
  failRemoteUrl = false;
  /** When true, `mergeFfOrCommit` throws (simulate a non-auto-recoverable merge conflict). */
  failMerge = false;
  /** Ordered log of git ops, for assertions. */
  readonly calls: string[] = [];
  /**
   * Records merges: branch → list of refs merged into it (for `mergeFfOrCommit`
   * assertions). Keyed by the branch name receiving the merge.
   */
  readonly mergesInto: Record<string, string[]> = {};
  /**
   * Test-injectable: files `diffNames` reports as changed on the given ref, keyed by
   * ref name. This fake models a flat per-branch changeset rather than a real
   * base-relative tree diff — `base` is accepted (interface parity) but ignored.
   * Unseeded refs report no changes (empty array), matching an untouched branch.
   */
  readonly branchFiles = new Map<string, string[]>();
  private head: string;
  private shaCounter = 0;

  constructor(opts: FakeGitOptions = {}) {
    const origin = new Map<string, string>();
    for (const [b, sha] of Object.entries(opts.remoteHeads ?? {})) origin.set(b, sha);
    this.remotes.set("origin", origin);
    for (const [b, fb] of Object.entries(opts.localBranches ?? {})) {
      this.localBranches.set(b, fb.sha);
    }
    this.head = opts.currentBranch ?? "main";
  }

  private nextSha(prefix = "sha"): string {
    this.shaCounter += 1;
    return `${prefix}-${this.shaCounter}`;
  }

  /** Test helper: advance a remote branch tip (simulate a merge landing). */
  setRemoteHead(branch: string, sha: string, remote = "origin"): void {
    let m = this.remotes.get(remote);
    if (!m) {
      m = new Map();
      this.remotes.set(remote, m);
    }
    m.set(branch, sha);
  }

  /** Test helper: read a remote branch tip. */
  getRemoteHead(branch: string, remote = "origin"): string | undefined {
    return this.remotes.get(remote)?.get(branch);
  }

  async fetch(remote: string, ref: string, _opts?: GitOpts): Promise<void> {
    this.calls.push(`fetch ${remote} ${ref}`);
  }

  /** Resolve which branch HEAD points at in the given cwd (worktree-aware). */
  private headBranch(opts?: GitOpts): string {
    if (opts?.cwd && this.worktrees.has(opts.cwd)) {
      return this.worktrees.get(opts.cwd)!;
    }
    return this.head;
  }

  async revParse(ref: string, opts?: GitOpts): Promise<string> {
    this.calls.push(`rev-parse ${ref}`);
    // "origin/<branch>" → remote head; bare branch → local; else synthesize.
    const remoteMatch = ref.match(/^origin\/(.+)$/);
    if (remoteMatch) {
      const name = remoteMatch[1]!; // capture group always present when matched
      const sha = this.remotes.get("origin")?.get(name);
      if (!sha) throw new Error(`fake git: cannot rev-parse '${ref}' (unknown remote ref)`);
      return sha;
    }
    if (ref === "HEAD") {
      // HEAD resolves to the branch checked out in this cwd's worktree (or the
      // global head when cwd is not a known worktree).
      const sha = this.localBranches.get(this.headBranch(opts));
      if (sha) return sha;
      throw new Error(`fake git: cannot rev-parse 'HEAD'`);
    }
    const local = this.localBranches.get(ref);
    if (local) return local;
    throw new Error(`fake git: cannot rev-parse '${ref}'`);
  }

  async branchExists(ref: string, _opts?: GitOpts): Promise<boolean> {
    const name = ref.replace(/^refs\/heads\//, "");
    return this.localBranches.has(name);
  }

  /** branch → commits-ahead count returned by {@link commitsAhead} (test-seeded). */
  readonly commitsAheadByBranch = new Map<string, number>();

  /** Test helper: program the commit count {@link commitsAhead} reports for a branch. */
  setCommitsAhead(branch: string, n: number): void {
    this.commitsAheadByBranch.set(branch, n);
  }

  async refExists(ref: string, _opts?: GitOpts): Promise<boolean> {
    // Resolve like revParse, but a miss is a normal NO (no throw): remote-tracking
    // `origin/<b>`, HEAD, or a local branch.
    const remoteMatch = ref.match(/^origin\/(.+)$/);
    if (remoteMatch) return this.remotes.get("origin")?.has(remoteMatch[1]!) ?? false;
    if (ref === "HEAD") return this.localBranches.has(this.head);
    return this.localBranches.has(ref);
  }

  async commitsAhead(_base: string, branch: string, _opts?: GitOpts): Promise<number> {
    return this.commitsAheadByBranch.get(branch) ?? 0;
  }

  /** Paths {@link isTracked} reports as git-tracked (test-seeded). */
  readonly trackedPaths = new Set<string>();

  async isTracked(relPath: string, _opts?: GitOpts): Promise<boolean> {
    return this.trackedPaths.has(relPath);
  }

  async checkoutB(branch: string, startPoint: string, _opts?: GitOpts): Promise<void> {
    this.calls.push(`checkout -B ${branch} ${startPoint}`);
    const startSha = await this.revParse(startPoint).catch(() => this.nextSha());
    this.localBranches.set(branch, startSha);
    this.head = branch;
  }

  async currentBranch(_opts?: GitOpts): Promise<string> {
    return this.head;
  }

  /** Test helper: configure the URL `remoteUrl` returns for a remote. */
  setRemoteUrl(remote: string, url: string): void {
    this.remoteUrls.set(remote, url);
  }

  async remoteUrl(remote: string, _opts?: GitOpts): Promise<string | null> {
    this.calls.push(`remote get-url ${remote}`);
    if (this.failRemoteUrl) return null;
    return this.remoteUrls.get(remote) ?? null;
  }

  async lsRemoteHeads(remote: string, branch: string, _opts?: GitOpts): Promise<string | null> {
    return this.remotes.get(remote)?.get(branch) ?? null;
  }

  async mergeBase(a: string, b: string, opts?: GitOpts): Promise<string> {
    this.calls.push(`merge-base ${a} ${b}`);
    const shaA = await this.revParse(a, opts);
    const shaB = await this.revParse(b, opts);
    // Fake convention: if the two resolve to the same sha, that IS the merge
    // base (branch born on the tip). Otherwise return a sentinel distinct from
    // both (drift) so assertBaseIsStagingTip can detect divergence.
    if (shaA === shaB) return shaA;
    return `merge-base(${shaA},${shaB})`;
  }

  async worktreeAdd(args: readonly string[], _opts?: GitOpts): Promise<void> {
    this.calls.push(`worktree add ${args.join(" ")}`);
    // Detached shape: `--detach <path> <startPoint>` (the traceability auditor's
    // no-branch checkout, S9). Registers the path so worktreeExists models resume.
    if (args[0] === "--detach") {
      const path = args[1];
      if (path !== undefined) {
        if (this.worktrees.has(path)) {
          throw new Error(`fatal: '${path}' already exists (worktree add)`);
        }
        this.worktrees.set(path, "(detached)");
      }
      return;
    }
    // Parse `-b|-B <branch> <path> <startPoint>` shape we emit from worktree.ts.
    const bIdx = args.findIndex((a) => a === "-b" || a === "-B");
    const force = args[bIdx] === "-B";
    const branch = bIdx >= 0 ? args[bIdx + 1] : undefined;
    const path = bIdx >= 0 ? args[bIdx + 2] : undefined;
    const startPoint = bIdx >= 0 ? args[bIdx + 3] : undefined;
    if (branch && path && startPoint) {
      // Faithful to real git: `git worktree add` FATALS when <path> is already a
      // registered worktree (the resume-wedge — a prior preflight created it, then
      // died before advancing). Model that so a non-idempotent re-create surfaces
      // as a failure here instead of a silent overwrite that hides the bug.
      if (this.worktrees.has(path)) {
        throw new Error(`fatal: '${path}' already exists (worktree add)`);
      }
      // Faithful to real git: a bare `-b` FATALS when <branch> already exists
      // locally — e.g. a crash left the branch behind after its worktree was
      // removed. `-B` force-creates/resets it regardless (the crash-safe mode).
      if (!force && this.localBranches.has(branch)) {
        throw new Error(`fatal: a branch named '${branch}' already exists`);
      }
      const startSha = await this.revParse(startPoint).catch(() => this.nextSha());
      this.localBranches.set(branch, startSha);
      this.worktrees.set(path, branch);
    }
  }

  async worktreeExists(path: string, _opts?: GitOpts): Promise<boolean> {
    return this.worktrees.has(path);
  }

  async worktreeRemove(args: readonly string[], _opts?: GitOpts): Promise<number | null> {
    this.calls.push(`worktree remove ${args.join(" ")}`);
    const path = args.find((a) => !a.startsWith("-"));
    if (path) this.worktrees.delete(path);
    return 0;
  }

  async push(remote: string, branch: string, opts?: PushOptions): Promise<void> {
    this.calls.push(`push${opts?.setUpstream ? " -u" : ""} ${remote} ${branch}`);
    const sha = this.localBranches.get(branch) ?? this.nextSha();
    this.setRemoteHead(branch, sha, remote);
  }

  async mergeFfOrCommit(branch: string, ref: string, _opts?: MergeOptions): Promise<void> {
    this.calls.push(`merge --no-edit ${ref} into ${branch}`);
    if (this.failMerge) {
      throw new Error(`merge conflict: ${ref} into ${branch} (simulated)`);
    }
    if (!this.mergesInto[branch]) this.mergesInto[branch] = [];
    this.mergesInto[branch]!.push(ref);
  }

  async resetHardClean(ref: string, opts?: GitOpts): Promise<void> {
    this.calls.push(`reset --hard ${ref}`);
    this.calls.push(`clean -fd`);
    // `git reset --hard <ref>` moves the cwd-worktree's checked-out branch tip to
    // `ref` (discarding the commits above it); `git clean -fd` drops untracked files.
    // The orchestrator passes the sha it captured at spawn-emit, so set the worktree's
    // branch tip back to it — restoring the pre-spawn state.
    this.localBranches.set(this.headBranch(opts), ref);
  }

  async diffNames(_base: string, ref: string, _opts?: GitOpts): Promise<string[]> {
    return this.branchFiles.get(ref) ?? [];
  }
}

// ---------------------------------------------------------------------------
// FakeGhClient
// ---------------------------------------------------------------------------

/** A PR row in the fake's table. */
interface FakePr extends PullRequest {}

/** Construction options for {@link FakeGhClient}. */
export interface FakeGhOptions {
  /** Seed PRs (keyed by head branch in the table). */
  prs?: PullRequest[];
  /** Seed branch protection per branch. */
  protection?: Record<string, ProtectionApiResult>;
  /** Force every prList/prView to report truncation (truncation-safety test). */
  truncate?: boolean;
  /** Default CI state returned by prChecks when no per-PR sequence is set. */
  checks?: ChecksState;
}

/**
 * In-memory GhClient. The PR table is keyed by head branch so idempotent-create
 * and serial-merge ordering are deterministic. Records calls so tests assert
 * exact call sequences (e.g. prCreate NEVER fired on a resume).
 */
export class FakeGhClient implements GhClient {
  /** head branch → PR. */
  readonly prs = new Map<string, FakePr>();
  /** branch → protection state. */
  readonly protection = new Map<string, ProtectionApiResult>();
  /** Ordered log of gh ops, for assertions. */
  readonly calls: string[] = [];
  /** Records each prCreate so tests assert it was/wasn't called. */
  readonly created: PrCreateArgs[] = [];
  /** Records each merge so tests assert ordering + which path (auto vs squash). */
  readonly merges: Array<{
    number: number;
    auto: boolean;
    deleteBranch: boolean;
    subject?: string;
  }> = [];
  /** Remote head refs deleted via deleteRemoteBranch (worktree-safe cleanup). */
  readonly deletedBranches: string[] = [];
  /** Branches whose protection was removed via deleteProtection. */
  readonly protectionDeletes: string[] = [];
  /** Records each issueComment call (PRD delivered comment + failure comment). */
  readonly issueComments: Array<{ number: number; body: string; repo: string }> = [];
  /** Records each issueClose call (PRD closed on completed runs). */
  readonly issueCloses: Array<{ number: number; repo: string; comment?: string }> = [];
  /** Per-PR CI sequences; each prChecks call shifts one (the last value sticks). */
  private readonly checksQueue = new Map<number, ChecksState[]>();
  private readonly defaultChecks: ChecksState;
  private numberCounter = 100;
  private readonly truncate: boolean;
  /**
   * Optional async barrier invoked at the START of prMergeSquash, BEFORE the
   * merge mutates state. Lets a test instrument the critical section to prove
   * serial (non-overlapping) execution.
   */
  onMergeEnter?: (number: number) => Promise<void> | void;
  /**
   * When set, deleteProtection throws this instead of recording the delete — lets a
   * test simulate a genuine GitHub failure (401/403/5xx) the real gh client propagates
   * (already-gone 404/422 it would tolerate, so those need no simulation).
   */
  failDeleteProtection?: Error;
  /** When set, deleteRemoteBranch throws this (simulate a propagated 401/403/5xx). */
  failDeleteRemoteBranch?: Error;
  /**
   * When set, mergeQueueProbe throws this instead of answering — simulates the
   * honest probe's "couldn't tell" throw (auth/rate-limit/5xx/truncated) so a test
   * can prove the caller degrades-and-logs rather than crashing (Theme D1).
   */
  failMergeQueueProbe?: Error;
  /**
   * When set, prMergeSquash throws this UNLESS `opts.auto` is true — simulates a
   * protected base branch rejecting an immediate merge while accepting the
   * `--auto` arm (D3: rollup's surgical branch-policy fallback).
   */
  failMergeSquashUnlessAuto?: Error;

  constructor(opts: FakeGhOptions = {}) {
    for (const pr of opts.prs ?? []) this.prs.set(pr.headRefName, pr);
    for (const [b, p] of Object.entries(opts.protection ?? {})) this.protection.set(b, p);
    this.truncate = opts.truncate ?? false;
    this.defaultChecks = opts.checks ?? "passing";
  }

  /** Test helper: directly seed/replace a PR row. */
  setPr(pr: PullRequest): void {
    this.prs.set(pr.headRefName, pr);
  }

  /**
   * Test helper: program the CI sequence prChecks returns for a PR. The last
   * value sticks (so `setChecks(n, "pending", "passing")` yields pending once,
   * then passing forever — modelling a poll loop that converges).
   */
  setChecks(number: number, ...states: ChecksState[]): void {
    this.checksQueue.set(number, states);
  }

  async prList(args: PrListArgs, _opts?: GhOpts): Promise<PullRequest[]> {
    this.calls.push(`pr list --head ${args.head} --state ${args.state ?? "open"}`);
    if (this.truncate) {
      throw new Error(
        "gh: output of 'gh pr list' was TRUNCATED (hit maxBuffer) — refusing to parse a clipped JSON payload",
      );
    }
    const pr = this.prs.get(args.head);
    if (!pr) return [];
    const wantState = args.state ?? "open";
    const matchesState =
      wantState === "all" ||
      (wantState === "open" && pr.state === "OPEN") ||
      (wantState === "closed" && pr.state === "CLOSED") ||
      (wantState === "merged" && pr.state === "MERGED");
    if (!matchesState) return [];
    if (args.base && pr.baseRefName !== args.base) return [];
    return [pr];
  }

  async prCreate(args: PrCreateArgs, _opts?: GhOpts): Promise<CreatedPr> {
    this.calls.push(`pr create --head ${args.head} --base ${args.base}`);
    this.created.push(args);
    const number = this.numberCounter++;
    const url = `https://github.com/fake/repo/pull/${number}`;
    this.prs.set(args.head, {
      number,
      headRefName: args.head,
      baseRefName: args.base,
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      url,
    });
    return { number, url };
  }

  async prView(number: number, _fields: readonly string[], _opts?: GhOpts): Promise<PullRequest> {
    this.calls.push(`pr view ${number}`);
    if (this.truncate) {
      throw new Error(
        "gh: output of 'gh pr view' was TRUNCATED (hit maxBuffer) — refusing to parse a clipped JSON payload",
      );
    }
    for (const pr of this.prs.values()) {
      if (pr.number === number) return pr;
    }
    throw new Error(`fake gh: no PR #${number}`);
  }

  async prChecks(number: number, _opts?: GhOpts): Promise<ChecksState> {
    this.calls.push(`pr checks ${number}`);
    const q = this.checksQueue.get(number);
    if (q && q.length > 0) {
      return q.length > 1 ? (q.shift() as ChecksState) : (q[0] as ChecksState);
    }
    return this.defaultChecks;
  }

  async prMergeSquash(number: number, opts?: PrMergeOptions & GhOpts): Promise<void> {
    if (this.onMergeEnter) await this.onMergeEnter(number);
    if (this.failMergeSquashUnlessAuto && !opts?.auto) throw this.failMergeSquashUnlessAuto;
    this.calls.push(`pr merge ${number} --squash${opts?.auto ? " --auto" : ""}`);
    this.merges.push({
      number,
      auto: opts?.auto ?? false,
      deleteBranch: opts?.deleteBranch ?? false,
      ...(opts?.subject !== undefined ? { subject: opts.subject } : {}),
    });
    for (const [head, pr] of this.prs.entries()) {
      if (pr.number === number) {
        // --auto enqueues; GitHub serializes later. Without --auto we merge now.
        this.prs.set(head, { ...pr, state: opts?.auto ? pr.state : "MERGED" });
        break;
      }
    }
  }

  async repoProtection(
    _owner: string,
    _repo: string,
    branch: string,
    _opts?: GhOpts,
  ): Promise<ProtectionApiResult> {
    this.calls.push(`api protection ${branch}`);
    return (
      this.protection.get(branch) ?? {
        enabled: false,
        requiredStatusChecks: [],
        strictUpToDate: false,
        hasMergeQueue: false,
      }
    );
  }

  async putProtection(
    _owner: string,
    _repo: string,
    branch: string,
    body: ProtectionPutBody,
    _opts?: GhOpts,
  ): Promise<void> {
    this.calls.push(`api PUT protection ${branch}`);
    const existing = this.protection.get(branch);
    this.protection.set(branch, {
      enabled: true,
      requiredStatusChecks: body.requiredStatusChecks,
      strictUpToDate: body.strict,
      hasMergeQueue: existing?.hasMergeQueue ?? false,
    });
  }

  async mergeQueueProbe(
    _owner: string,
    _repo: string,
    branch: string,
    _opts?: GhOpts,
  ): Promise<boolean> {
    if (this.failMergeQueueProbe) throw this.failMergeQueueProbe;
    return this.protection.get(branch)?.hasMergeQueue ?? false;
  }

  async deleteRemoteBranch(
    _owner: string,
    _repo: string,
    branch: string,
    _opts?: GhOpts,
  ): Promise<void> {
    if (this.failDeleteRemoteBranch) throw this.failDeleteRemoteBranch;
    this.calls.push(`api DELETE refs/heads/${branch}`);
    this.deletedBranches.push(branch);
  }

  async deleteProtection(
    _owner: string,
    _repo: string,
    branch: string,
    _opts?: GhOpts,
  ): Promise<void> {
    if (this.failDeleteProtection) throw this.failDeleteProtection;
    this.calls.push(`api DELETE protection ${branch}`);
    this.protectionDeletes.push(branch);
    this.protection.delete(branch);
  }

  async issueComment(
    args: { repo: string; number: number; body: string },
    _opts?: GhOpts,
  ): Promise<void> {
    this.calls.push(`issue comment ${args.number}`);
    this.issueComments.push({ number: args.number, body: args.body, repo: args.repo });
  }

  /** Backed by the same recording array issueComment writes, so the finalize marker
   * dedup is exercised for real (post once → re-finalize sees the marker → skips). */
  async listIssueComments(
    args: { repo: string; number: number },
    _opts?: GhOpts,
  ): Promise<string[]> {
    this.calls.push(`issue view ${args.number} --json comments`);
    return this.issueComments
      .filter((c) => c.repo === args.repo && c.number === args.number)
      .map((c) => c.body);
  }

  async issueClose(
    args: { repo: string; number: number; comment?: string },
    _opts?: GhOpts,
  ): Promise<void> {
    this.calls.push(`issue close ${args.number}`);
    this.issueCloses.push({
      number: args.number,
      repo: args.repo,
      ...(args.comment !== undefined ? { comment: args.comment } : {}),
    });
  }
}
