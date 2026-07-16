/**
 * WS3 — exported in-memory fakes implementing GitClient / GhClient.
 *
 * These satisfy "mock seams via exported types/constructors, not by stubbing exec
 * or editing seam files". They model an in-memory repo (branches, worktrees, a PR
 * table keyed by head branch) so idempotent-create, serial-merge ordering, and
 * protection state are all SCRIPTABLE with zero real git/gh invocation. Every
 * WS3 unit test and downstream consumer (WS6/WS10/WS12) uses these fixtures.
 *
 * Interface-parity note: these fakes have sync bodies but must satisfy the
 * Promise-returning GitClient/GhClient signatures. Non-throwing methods drop
 * `async` and `return Promise.resolve(x)`; methods that model a failure return
 * `Promise.reject(err)` (NOT a synchronous `throw`) so `.catch()`/`.rejects`
 * consumers observe a real rejection, exactly as with the real async clients.
 */
import type {GitClient, GitOpts, MergeAttempt, MergeOptions, PushOptions} from './git-client.js'
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
} from './gh-client.js'
import {nonNull, getOrThrow} from '../shared/index.js'

// ---------------------------------------------------------------------------
// FakeGitClient
// ---------------------------------------------------------------------------

interface FakeBranch {
    /** Synthetic sha for the branch tip. */
    sha: string
}

/** Construction options for {@link FakeGitClient}. */
export interface FakeGitOptions {
    /** Seed remote branches: name → sha (e.g. {"staging": "sha-staging-1"}). */
    remoteHeads?: Record<string, string>
    /** Seed local branches. */
    localBranches?: Record<string, FakeBranch>
    /** Current branch HEAD points at. */
    currentBranch?: string
    /** Absolute repo root `showToplevel` reports (defaults to `/repo`). */
    repoRoot?: string
}

/**
 * In-memory GitClient. Records every mutating call so tests can assert ordering
 * and — critically — that NO force-push path is ever taken (there is no such
 * method to call).
 */
export class FakeGitClient implements GitClient {
    /** remote name → (branch → sha). */
    readonly remotes = new Map<string, Map<string, string>>()
    /** local branch name → tip sha. */
    readonly localBranches = new Map<string, string>()
    /** worktree path → branch checked out there. */
    readonly worktrees = new Map<string, string>()
    /** remote name → configured remote URL (for `remoteUrl` / `--repo` auto-derive). */
    readonly remoteUrls = new Map<string, string>()
    /** When true, `remoteUrl` reports a miss (simulate a non-git dir / no remote). */
    failRemoteUrl = false
    /** When true, `mergeFfOrCommit` throws (simulate a non-auto-recoverable merge conflict). */
    failMerge = false
    /** When true, `tryMergeNoForce` reports `{merged:false}` (conflict) instead of merging. */
    failMergeNoForce = false
    /** Ordered log of git ops, for assertions. */
    readonly calls: string[] = []
    /**
     * Records merges: branch → list of refs merged into it (for `mergeFfOrCommit`
     * assertions). Keyed by the branch name receiving the merge.
     */
    readonly mergesInto: Record<string, string[]> = {}
    /**
     * Test-injectable: files `diffNames` reports as changed on the given ref, keyed by
     * ref name. This fake models a flat per-branch changeset rather than a real
     * base-relative tree diff — `base` is accepted (interface parity) but ignored.
     * Unseeded refs report no changes (empty array), matching an untouched branch.
     */
    readonly branchFiles = new Map<string, string[]>()
    private head: string
    private shaCounter = 0
    private readonly repoRoot: string

    constructor(opts: FakeGitOptions = {}) {
        const origin = new Map<string, string>()
        for (const [b, sha] of Object.entries(opts.remoteHeads ?? {})) {
            origin.set(b, sha)
        }
        this.remotes.set('origin', origin)
        for (const [b, fb] of Object.entries(opts.localBranches ?? {})) {
            this.localBranches.set(b, fb.sha)
        }
        this.head = opts.currentBranch ?? 'main'
        this.repoRoot = opts.repoRoot ?? '/repo'
    }

    showToplevel(_opts?: GitOpts): Promise<string> {
        return Promise.resolve(this.repoRoot)
    }

    mainWorktreeRoot(_opts?: GitOpts): Promise<string> {
        return Promise.resolve(this.repoRoot)
    }

    private nextSha(prefix = 'sha'): string {
        this.shaCounter += 1
        return `${prefix}-${this.shaCounter}`
    }

    /** Test helper: advance a remote branch tip (simulate a merge landing). */
    setRemoteHead(branch: string, sha: string, remote = 'origin'): void {
        let m = this.remotes.get(remote)
        if (!m) {
            m = new Map()
            this.remotes.set(remote, m)
        }
        m.set(branch, sha)
    }

    /** Test helper: read a remote branch tip. */
    getRemoteHead(branch: string, remote = 'origin'): string | undefined {
        return this.remotes.get(remote)?.get(branch)
    }

    fetch(remote: string, ref: string, _opts?: GitOpts): Promise<void> {
        this.calls.push(`fetch ${remote} ${ref}`)
        return Promise.resolve()
    }

    /** Resolve which branch HEAD points at in the given cwd (worktree-aware). */
    private headBranch(opts?: GitOpts): string {
        if (opts?.cwd != null && this.worktrees.has(opts.cwd)) {
            return getOrThrow(this.worktrees, opts.cwd)
        }
        return this.head
    }

    revParse(ref: string, opts?: GitOpts): Promise<string> {
        this.calls.push(`rev-parse ${ref}`)
        // "origin/<branch>" → remote head; bare branch → local; else synthesize.
        const remoteMatch = /^origin\/(.+)$/.exec(ref)
        if (remoteMatch) {
            const name = nonNull(remoteMatch[1]) // capture group always present when matched
            const sha = this.remotes.get('origin')?.get(name)
            if (sha == null) {
                return Promise.reject(new Error(`fake git: cannot rev-parse '${ref}' (unknown remote ref)`))
            }
            return Promise.resolve(sha)
        }
        if (ref === 'HEAD') {
            // HEAD resolves to the branch checked out in this cwd's worktree (or the
            // global head when cwd is not a known worktree).
            const sha = this.localBranches.get(this.headBranch(opts))
            if (sha != null) {
                return Promise.resolve(sha)
            }
            return Promise.reject(new Error(`fake git: cannot rev-parse 'HEAD'`))
        }
        const local = this.localBranches.get(ref)
        if (local != null) {
            return Promise.resolve(local)
        }
        return Promise.reject(new Error(`fake git: cannot rev-parse '${ref}'`))
    }

    branchExists(ref: string, _opts?: GitOpts): Promise<boolean> {
        const name = ref.replace(/^refs\/heads\//, '')
        return Promise.resolve(this.localBranches.has(name))
    }

    /** branch → commits-ahead count returned by {@link commitsAhead} (test-seeded). */
    readonly commitsAheadByBranch = new Map<string, number>()

    /** Test helper: program the commit count {@link commitsAhead} reports for a branch. */
    setCommitsAhead(branch: string, n: number): void {
        this.commitsAheadByBranch.set(branch, n)
    }

    refExists(ref: string, _opts?: GitOpts): Promise<boolean> {
        // Resolve like revParse, but a miss is a normal NO (no throw): remote-tracking
        // `origin/<b>`, HEAD, or a local branch.
        const remoteMatch = /^origin\/(.+)$/.exec(ref)
        if (remoteMatch) {
            return Promise.resolve(this.remotes.get('origin')?.has(nonNull(remoteMatch[1])) ?? false)
        }
        if (ref === 'HEAD') {
            return Promise.resolve(this.localBranches.has(this.head))
        }
        return Promise.resolve(this.localBranches.has(ref))
    }

    commitsAhead(_base: string, branch: string, _opts?: GitOpts): Promise<number> {
        return Promise.resolve(this.commitsAheadByBranch.get(branch) ?? 0)
    }

    /** Paths {@link isTracked} reports as git-tracked (test-seeded). */
    readonly trackedPaths = new Set<string>()

    isTracked(relPath: string, _opts?: GitOpts): Promise<boolean> {
        return Promise.resolve(this.trackedPaths.has(relPath))
    }

    async checkoutB(branch: string, startPoint: string, _opts?: GitOpts): Promise<void> {
        this.calls.push(`checkout -B ${branch} ${startPoint}`)
        const startSha = await this.revParse(startPoint).catch(() => this.nextSha())
        this.localBranches.set(branch, startSha)
        this.head = branch
    }

    currentBranch(_opts?: GitOpts): Promise<string> {
        return Promise.resolve(this.head)
    }

    /** Test helper: configure the URL `remoteUrl` returns for a remote. */
    setRemoteUrl(remote: string, url: string): void {
        this.remoteUrls.set(remote, url)
    }

    remoteUrl(remote: string, _opts?: GitOpts): Promise<string | null> {
        this.calls.push(`remote get-url ${remote}`)
        if (this.failRemoteUrl) {
            return Promise.resolve(null)
        }
        return Promise.resolve(this.remoteUrls.get(remote) ?? null)
    }

    lsRemoteHeads(remote: string, branch: string, _opts?: GitOpts): Promise<string | null> {
        return Promise.resolve(this.remotes.get(remote)?.get(branch) ?? null)
    }

    async mergeBase(a: string, b: string, opts?: GitOpts): Promise<string> {
        this.calls.push(`merge-base ${a} ${b}`)
        const shaA = await this.revParse(a, opts)
        const shaB = await this.revParse(b, opts)
        // Fake convention: if the two resolve to the same sha, that IS the merge
        // base (branch born on the tip). Otherwise return a sentinel distinct from
        // both (drift) so assertBaseIsStagingTip can detect divergence.
        if (shaA === shaB) {
            return shaA
        }
        return `merge-base(${shaA},${shaB})`
    }

    async worktreeAdd(args: readonly string[], _opts?: GitOpts): Promise<void> {
        this.calls.push(`worktree add ${args.join(' ')}`)
        // Detached shape: `--detach <path> <startPoint>` (the traceability auditor's
        // no-branch checkout, S9). Registers the path so worktreeExists models resume.
        if (args[0] === '--detach') {
            const path = args[1]
            if (path !== undefined) {
                if (this.worktrees.has(path)) {
                    throw new Error(`fatal: '${path}' already exists (worktree add)`)
                }
                this.worktrees.set(path, '(detached)')
            }
            return
        }
        // Parse `-b|-B <branch> <path> <startPoint>` shape we emit from worktree.ts.
        const bIdx = args.findIndex((a) => a === '-b' || a === '-B')
        const force = args[bIdx] === '-B'
        const branch = bIdx >= 0 ? args[bIdx + 1] : undefined
        const path = bIdx >= 0 ? args[bIdx + 2] : undefined
        const startPoint = bIdx >= 0 ? args[bIdx + 3] : undefined
        if (branch != null && path != null && startPoint != null) {
            // Faithful to real git: `git worktree add` FATALS when <path> is already a
            // registered worktree (the resume-wedge — a prior preflight created it, then
            // died before advancing). Model that so a non-idempotent re-create surfaces
            // as a failure here instead of a silent overwrite that hides the bug.
            if (this.worktrees.has(path)) {
                throw new Error(`fatal: '${path}' already exists (worktree add)`)
            }
            // Faithful to real git: a bare `-b` FATALS when <branch> already exists
            // locally — e.g. a crash left the branch behind after its worktree was
            // removed. `-B` force-creates/resets it regardless (the crash-safe mode).
            if (!force && this.localBranches.has(branch)) {
                throw new Error(`fatal: a branch named '${branch}' already exists`)
            }
            const startSha = await this.revParse(startPoint).catch(() => this.nextSha())
            this.localBranches.set(branch, startSha)
            this.worktrees.set(path, branch)
        }
    }

    worktreeExists(path: string, _opts?: GitOpts): Promise<boolean> {
        return Promise.resolve(this.worktrees.has(path))
    }

    worktreeRemove(args: readonly string[], _opts?: GitOpts): Promise<number | null> {
        this.calls.push(`worktree remove ${args.join(' ')}`)
        const path = args.find((a) => !a.startsWith('-'))
        if (path != null) {
            this.worktrees.delete(path)
        }
        return Promise.resolve(0)
    }

    push(remote: string, branch: string, opts?: PushOptions): Promise<void> {
        this.calls.push(`push${opts?.setUpstream === true ? ' -u' : ''} ${remote} ${branch}`)
        const sha = this.localBranches.get(branch) ?? this.nextSha()
        this.setRemoteHead(branch, sha, remote)
        return Promise.resolve()
    }

    mergeFfOrCommit(branch: string, ref: string, _opts?: MergeOptions): Promise<void> {
        this.calls.push(`merge --no-edit ${ref} into ${branch}`)
        if (this.failMerge) {
            return Promise.reject(new Error(`merge conflict: ${ref} into ${branch} (simulated)`))
        }
        this.mergesInto[branch] ??= []
        this.mergesInto[branch].push(ref)
        return Promise.resolve()
    }

    tryMergeNoForce(branch: string, ref: string, opts?: MergeOptions): Promise<MergeAttempt> {
        this.calls.push(
            opts?.message !== undefined
                ? `try-merge -m "${opts.message}" ${ref} into ${branch}`
                : `try-merge --no-edit ${ref} into ${branch}`
        )
        // `failMergeNoForce` set → model a conflict (tree already aborted-to-clean, per the
        // real client's contract) WITHOUT throwing, so tests exercise the conflict branch.
        if (this.failMergeNoForce) {
            this.calls.push(`merge --abort`)
            return Promise.resolve({merged: false, conflict: `conflict: ${ref} into ${branch} (simulated)`})
        }
        this.mergesInto[branch] ??= []
        this.mergesInto[branch].push(ref)
        return Promise.resolve({merged: true})
    }

    resetHardClean(ref: string, opts?: GitOpts): Promise<void> {
        this.calls.push(`reset --hard ${ref}`)
        this.calls.push(`clean -fd`)
        // `git reset --hard <ref>` moves the cwd-worktree's checked-out branch tip to
        // `ref` (discarding the commits above it); `git clean -fd` drops untracked files.
        // The orchestrator passes the sha it captured at spawn-emit, so set the worktree's
        // branch tip back to it — restoring the pre-spawn state.
        this.localBranches.set(this.headBranch(opts), ref)
        return Promise.resolve()
    }

    diffNames(_base: string, ref: string, _opts?: GitOpts): Promise<string[]> {
        return Promise.resolve(this.branchFiles.get(ref) ?? [])
    }
}

// ---------------------------------------------------------------------------
// FakeGhClient
// ---------------------------------------------------------------------------

/** A PR row in the fake's table. */
type FakePr = PullRequest

/** Construction options for {@link FakeGhClient}. */
export interface FakeGhOptions {
    /** Seed PRs (keyed by head branch in the table). */
    prs?: PullRequest[]
    /** Seed branch protection per branch. */
    protection?: Record<string, ProtectionApiResult>
    /** Force every prList/prView to report truncation (truncation-safety test). */
    truncate?: boolean
    /** Default CI state returned by prChecks when no per-PR sequence is set. */
    checks?: ChecksState
}

/**
 * In-memory GhClient. The PR table is keyed by head branch so idempotent-create
 * and serial-merge ordering are deterministic. Records calls so tests assert
 * exact call sequences (e.g. prCreate NEVER fired on a resume).
 */
export class FakeGhClient implements GhClient {
    /** head branch → PR. */
    readonly prs = new Map<string, FakePr>()
    /** branch → protection state. */
    readonly protection = new Map<string, ProtectionApiResult>()
    /** Ordered log of gh ops, for assertions. */
    readonly calls: string[] = []
    /** Records each prCreate so tests assert it was/wasn't called. */
    readonly created: PrCreateArgs[] = []
    /** Records each merge so tests assert ordering + which path (auto vs squash). */
    readonly merges: {
        number: number
        auto: boolean
        deleteBranch: boolean
        subject?: string
    }[] = []
    /** Remote head refs deleted via deleteRemoteBranch (worktree-safe cleanup). */
    readonly deletedBranches: string[] = []
    /** Remote branches branchExists answers true for (seed directly; deleteRemoteBranch removes). */
    readonly remoteBranches = new Set<string>()
    /** Optional per-branch tip shas branchTip reports (else a fixed placeholder). */
    readonly branchTips = new Map<string, string>()
    /** Branches whose protection was removed via deleteProtection. */
    readonly protectionDeletes: string[] = []
    /** Ordered log of putProtection bodies — assert exact profiles (strict/contexts/enforceAdmins). */
    readonly protectionPuts: {branch: string; body: ProtectionPutBody}[] = []
    /** Records each issueComment call (PRD delivered comment + failure comment). */
    readonly issueComments: {number: number; body: string; repo: string}[] = []
    /** Records each issueClose call (PRD closed on completed runs). */
    readonly issueCloses: {number: number; repo: string; comment?: string}[] = []
    /** Per-PR CI sequences; each prChecks call shifts one (the last value sticks). */
    private readonly checksQueue = new Map<number, ChecksState[]>()
    /**
     * Per-PR mergeable/mergeStateStatus/state override sequence; each prView call
     * shifts one (the last value sticks) — models GitHub settling `UNKNOWN` after a
     * beat (Issue #1) and a merge-queue landing/kicking an enqueued PR, mirroring
     * `checksQueue`.
     */
    private readonly mergeabilityQueue = new Map<
        number,
        Partial<Pick<PullRequest, 'mergeable' | 'mergeStateStatus' | 'state'>>[]
    >()
    private readonly defaultChecks: ChecksState
    private numberCounter = 100
    private readonly truncate: boolean
    /**
     * Optional async barrier invoked at the START of prMergeSquash, BEFORE the
     * merge mutates state. Lets a test instrument the critical section to prove
     * serial (non-overlapping) execution.
     */
    onMergeEnter?: (number: number) => Promise<void> | void
    /**
     * When set, deleteProtection throws this instead of recording the delete — lets a
     * test simulate a genuine GitHub failure (401/403/5xx) the real gh client propagates
     * (already-gone 404/422 it would tolerate, so those need no simulation).
     */
    failDeleteProtection?: Error | undefined
    /**
     * When set, putProtection for THIS branch rejects (simulated 401/403/5xx) while
     * other branches' PUTs still succeed — lets a test fail only the develop
     * escalation after the staging provision already landed (D74).
     */
    failPutProtectionFor?: string
    /** When set, deleteRemoteBranch throws this (simulate a propagated 401/403/5xx). */
    failDeleteRemoteBranch?: Error
    /**
     * When set, mergeQueueProbe throws this instead of answering — simulates the
     * honest probe's "couldn't tell" throw (auth/rate-limit/5xx/truncated) so a test
     * can prove the caller degrades-and-logs rather than crashing (Theme D1).
     */
    failMergeQueueProbe?: Error
    /**
     * When set, prMergeSquash throws this UNLESS `opts.auto` is true — simulates a
     * protected base branch rejecting an immediate merge while accepting the
     * `--auto` arm (D3: rollup's surgical branch-policy fallback).
     */
    failMergeSquashUnlessAuto?: Error

    constructor(opts: FakeGhOptions = {}) {
        for (const pr of opts.prs ?? []) {
            this.prs.set(pr.headRefName, pr)
        }
        for (const [b, p] of Object.entries(opts.protection ?? {})) {
            this.protection.set(b, p)
        }
        this.truncate = opts.truncate ?? false
        this.defaultChecks = opts.checks ?? 'passing'
    }

    /** Test helper: directly seed/replace a PR row. */
    setPr(pr: PullRequest): void {
        this.prs.set(pr.headRefName, pr)
    }

    /**
     * Test helper: program the CI sequence prChecks returns for a PR. The last
     * value sticks (so `setChecks(n, "pending", "passing")` yields pending once,
     * then passing forever — modelling a poll loop that converges).
     */
    setChecks(number: number, ...states: ChecksState[]): void {
        this.checksQueue.set(number, states)
    }

    /**
     * Test helper: program the mergeable/mergeStateStatus sequence prView returns for
     * `number`. The last entry sticks (mirrors `setChecks`) — use to simulate GitHub
     * reporting `UNKNOWN` for a beat before settling to a terminal state.
     */
    setMergeabilitySequence(
        number: number,
        ...states: Partial<Pick<PullRequest, 'mergeable' | 'mergeStateStatus' | 'state'>>[]
    ): void {
        this.mergeabilityQueue.set(number, [...states])
    }

    prList(args: PrListArgs, _opts?: GhOpts): Promise<PullRequest[]> {
        this.calls.push(`pr list --head ${args.head} --state ${args.state ?? 'open'}`)
        if (this.truncate) {
            return Promise.reject(
                new Error(
                    "gh: output of 'gh pr list' was TRUNCATED (hit maxBuffer) — refusing to parse a clipped JSON payload"
                )
            )
        }
        const pr = this.prs.get(args.head)
        if (!pr) {
            return Promise.resolve([])
        }
        const wantState = args.state ?? 'open'
        const matchesState =
            wantState === 'all' ||
            (wantState === 'open' && pr.state === 'OPEN') ||
            (wantState === 'closed' && pr.state === 'CLOSED') ||
            (wantState === 'merged' && pr.state === 'MERGED')
        if (!matchesState) {
            return Promise.resolve([])
        }
        if (args.base != null && pr.baseRefName !== args.base) {
            return Promise.resolve([])
        }
        return Promise.resolve([pr])
    }

    prCreate(args: PrCreateArgs, _opts?: GhOpts): Promise<CreatedPr> {
        this.calls.push(`pr create --head ${args.head} --base ${args.base}`)
        this.created.push(args)
        const number = this.numberCounter++
        const url = `https://github.com/fake/repo/pull/${number}`
        this.prs.set(args.head, {
            number,
            headRefName: args.head,
            baseRefName: args.base,
            state: 'OPEN',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            url,
        })
        return Promise.resolve({number, url})
    }

    prView(number: number, _fields: readonly string[], _opts?: GhOpts): Promise<PullRequest> {
        this.calls.push(`pr view ${number}`)
        if (this.truncate) {
            return Promise.reject(
                new Error(
                    "gh: output of 'gh pr view' was TRUNCATED (hit maxBuffer) — refusing to parse a clipped JSON payload"
                )
            )
        }
        for (const pr of this.prs.values()) {
            if (pr.number === number) {
                const q = this.mergeabilityQueue.get(number)
                if (q && q.length > 0) {
                    const next = q.length > 1 ? nonNull(q.shift()) : nonNull(q[0])
                    return Promise.resolve({...pr, ...next})
                }
                return Promise.resolve(pr)
            }
        }
        return Promise.reject(new Error(`fake gh: no PR #${number}`))
    }

    prChecks(number: number, _opts?: GhOpts): Promise<ChecksState> {
        this.calls.push(`pr checks ${number}`)
        const q = this.checksQueue.get(number)
        if (q && q.length > 0) {
            return Promise.resolve(q.length > 1 ? nonNull(q.shift()) : nonNull(q[0]))
        }
        return Promise.resolve(this.defaultChecks)
    }

    async prMergeSquash(number: number, opts?: PrMergeOptions & GhOpts): Promise<void> {
        if (this.onMergeEnter) {
            await this.onMergeEnter(number)
        }
        if (this.failMergeSquashUnlessAuto != null && opts?.auto !== true) {
            throw this.failMergeSquashUnlessAuto
        }
        this.calls.push(`pr merge ${number} --squash${opts?.auto === true ? ' --auto' : ''}`)
        this.merges.push({
            number,
            auto: opts?.auto ?? false,
            deleteBranch: opts?.deleteBranch ?? false,
            ...(opts?.subject !== undefined ? {subject: opts.subject} : {}),
        })
        for (const [head, pr] of this.prs.entries()) {
            if (pr.number === number) {
                // --auto enqueues; GitHub serializes later. Without --auto we merge now.
                this.prs.set(head, {...pr, state: opts?.auto === true ? pr.state : 'MERGED'})
                break
            }
        }
    }

    repoProtection(_owner: string, _repo: string, branch: string, _opts?: GhOpts): Promise<ProtectionApiResult> {
        this.calls.push(`api protection ${branch}`)
        return Promise.resolve(
            this.protection.get(branch) ?? {
                enabled: false,
                requiredStatusChecks: [],
                strictUpToDate: false,
                hasMergeQueue: false,
            }
        )
    }

    putProtection(
        _owner: string,
        _repo: string,
        branch: string,
        body: ProtectionPutBody,
        _opts?: GhOpts
    ): Promise<void> {
        if (this.failPutProtectionFor === branch) {
            return Promise.reject(new Error(`simulated putProtection failure for '${branch}'`))
        }
        this.calls.push(`api PUT protection ${branch}`)
        this.protectionPuts.push({branch, body})
        const existing = this.protection.get(branch)
        this.protection.set(branch, {
            enabled: true,
            requiredStatusChecks: body.requiredStatusChecks,
            strictUpToDate: body.strict,
            hasMergeQueue: existing?.hasMergeQueue ?? false,
        })
        return Promise.resolve()
    }

    mergeQueueProbe(_owner: string, _repo: string, branch: string, _opts?: GhOpts): Promise<boolean> {
        if (this.failMergeQueueProbe) {
            return Promise.reject(this.failMergeQueueProbe)
        }
        return Promise.resolve(this.protection.get(branch)?.hasMergeQueue ?? false)
    }

    deleteRemoteBranch(_owner: string, _repo: string, branch: string, _opts?: GhOpts): Promise<void> {
        if (this.failDeleteRemoteBranch) {
            return Promise.reject(this.failDeleteRemoteBranch)
        }
        this.calls.push(`api DELETE refs/heads/${branch}`)
        this.deletedBranches.push(branch)
        this.remoteBranches.delete(branch)
        return Promise.resolve()
    }

    branchExists(_owner: string, _repo: string, branch: string, _opts?: GhOpts): Promise<boolean> {
        this.calls.push(`api branch ${branch}`)
        return Promise.resolve(this.remoteBranches.has(branch))
    }

    branchTip(_owner: string, _repo: string, branch: string, _opts?: GhOpts): Promise<string | null> {
        this.calls.push(`api branch ${branch}`)
        if (!this.remoteBranches.has(branch)) {
            return Promise.resolve(null)
        }
        return Promise.resolve(this.branchTips.get(branch) ?? 'fake-tip-sha')
    }

    deleteProtection(_owner: string, _repo: string, branch: string, _opts?: GhOpts): Promise<void> {
        if (this.failDeleteProtection) {
            return Promise.reject(this.failDeleteProtection)
        }
        this.calls.push(`api DELETE protection ${branch}`)
        this.protectionDeletes.push(branch)
        this.protection.delete(branch)
        return Promise.resolve()
    }

    issueComment(args: {repo: string; number: number; body: string}, _opts?: GhOpts): Promise<void> {
        this.calls.push(`issue comment ${args.number}`)
        this.issueComments.push({number: args.number, body: args.body, repo: args.repo})
        return Promise.resolve()
    }

    /** Backed by the same recording array issueComment writes, so the finalize marker
     * dedup is exercised for real (post once → re-finalize sees the marker → skips). */
    listIssueComments(args: {repo: string; number: number}, _opts?: GhOpts): Promise<string[]> {
        this.calls.push(`issue view ${args.number} --json comments`)
        return Promise.resolve(
            this.issueComments.filter((c) => c.repo === args.repo && c.number === args.number).map((c) => c.body)
        )
    }

    issueClose(args: {repo: string; number: number; comment?: string}, _opts?: GhOpts): Promise<void> {
        this.calls.push(`issue close ${args.number}`)
        this.issueCloses.push({
            number: args.number,
            repo: args.repo,
            ...(args.comment !== undefined ? {comment: args.comment} : {}),
        })
        return Promise.resolve()
    }
}
