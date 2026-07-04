/**
 * WS3 — SERIAL WRITER #1 (Δ L, §9.2).
 *
 * Merges into `staging` are serialized in EVERY mode: task PRs land ONE at a
 * time. The mechanism is an app-level merge LOCK (proper-lockfile, the SAME lock
 * primitive WS1's StateManager uses) on a data-dir merge-lock file, plus
 * required-branches-up-to-date enforcement (which works on ANY GitHub plan):
 *
 *   acquire lock
 *     -> verify the PR is mergeable AND its head is up-to-date with staging
 *     -> if BEHIND: refuse/yield (no force-push, no rebase-publish — global rule)
 *     -> `gh pr merge --squash` (NOT N concurrent `--auto`)
 *   release lock
 *
 * Probe-detected upgrade: if mergeQueueProbe() reports native GitHub merge-queue,
 * enqueue via `--auto` and let GitHub serialize instead (still one logical
 * serializer; never N concurrent app-level merges). merge-queue-as-default is v2.
 *
 * The app-level lock NEVER arms N concurrent `--auto`: two concurrent merge()
 * calls observe strictly non-overlapping critical sections.
 */
import {join} from 'node:path'
import {createLogger, withFileLock, DEFAULT_FILE_LOCK_TUNING, type FileLockTuning} from '../shared/index.js'
import {GitSchema} from '../config/schema.js'
import {resolveDataDir, type DataDirOptions} from '../config/load.js'
import type {GhClient} from './gh-client.js'

const log = createLogger('git')

const GIT_DEFAULTS = GitSchema.parse({})

/**
 * Lock tuning — the shared {@link FileLockTuning}; kept as a local alias so the
 * re-export from `./index.ts` stays stable.
 */
export type MergeLockTuning = FileLockTuning

/**
 * Merge overrides on the shared baseline: a git+GitHub merge legitimately runs
 * longer than a state write, so widen the stale window and retry budget.
 */
const MERGE_LOCK_DEFAULTS: MergeLockTuning = {
    ...DEFAULT_FILE_LOCK_TUNING,
    stale: 30_000,
    retries: 100,
    retryMinTimeout: 25,
    retryMaxTimeout: 1000,
}

/** Outcome of a {@link MergeSerializer.merge} attempt. */
export type MergeOutcome =
    | {merged: true; via: 'app-level' | 'merge-queue'; number: number}
    | {merged: false; reason: 'behind' | 'not-mergeable'; number: number}

/** Options for {@link MergeSerializer}. */
export interface MergeSerializerOptions extends DataDirOptions {
    ghClient: GhClient
    owner: string
    repo: string
    /** Integration branch. Defaults to the configured staging branch. */
    stagingBranch?: string
    /** Override the merge-lock scope id (default: repo-scoped key). */
    lockScope?: string
    lock?: Partial<MergeLockTuning>
}

/**
 * Serializes task-PR merges into staging behind an app-level lock. The lock is
 * REPO-SCOPED by default (keyed on owner/repo + staging branch) so concurrent
 * RUNS sharing the same staging branch still serialize (§9.2: staging is THE
 * single serial writer).
 */
export class MergeSerializer {
    private readonly ghClient: GhClient
    private readonly owner: string
    private readonly repo: string
    private readonly staging: string
    private readonly dataDir: string
    private readonly lockScope: string
    private readonly tuning: MergeLockTuning

    constructor(opts: MergeSerializerOptions) {
        this.ghClient = opts.ghClient
        this.owner = opts.owner
        this.repo = opts.repo
        this.staging = opts.stagingBranch ?? GIT_DEFAULTS.stagingBranch
        this.dataDir = resolveDataDir(opts)
        this.lockScope = opts.lockScope ?? `${opts.owner}__${opts.repo}__${this.staging}`.replace(/[^\w.-]/g, '-')
        this.tuning = {...MERGE_LOCK_DEFAULTS, ...(opts.lock ?? {})}
    }

    private lockfilePath(): string {
        return join(this.dataDir, 'locks', `merge-${this.lockScope}.lock`)
    }

    /** Run `fn` while holding the app-level merge lock (the serial section). */
    private async withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
        return withFileLock(
            {
                dir: join(this.dataDir, 'locks'),
                lockfile: this.lockfilePath(),
                label: `merge '${this.lockScope}'`,
                dirPolicy: 'create',
                tuning: this.tuning,
            },
            fn
        )
    }

    /**
     * Serial-merge one task PR into staging. Acquires the app-level lock, RE-VERIFIES
     * mergeable + up-to-date against the CURRENT staging tip (so the 2nd of two
     * queued merges re-checks against the post-first-merge state), then either
     * enqueues via native merge-queue (probe upgrade) or squash-merges now. NEVER
     * arms N concurrent `--auto`.
     */
    async merge(prNumber: number): Promise<MergeOutcome> {
        return this.withMergeLock(async () => {
            // Re-read the PR INSIDE the lock — its mergeable/up-to-date state may have
            // changed since the caller queued (e.g. a prior merge advanced staging).
            const pr = await this.ghClient.prView(prNumber, [
                'number',
                'headRefName',
                'baseRefName',
                'state',
                'mergeable',
                'mergeStateStatus',
            ])

            // Idempotent resume (Δ P): ship can crash AFTER the merge lands but BEFORE
            // the run records `done` (e.g. a post-merge cleanup error). Re-running drive
            // — the sanctioned retry — re-enters here; re-merging a MERGED PR errors, so
            // treat it as success and (best-effort) finish the remote-ref cleanup that
            // the interrupted attempt may have skipped.
            if (pr.state === 'MERGED') {
                log.info(`PR #${prNumber} already MERGED into ${this.staging} — ship resuming`)
                await this.deleteMergedHeadBestEffort(pr.headRefName)
                return {merged: true, via: 'app-level', number: prNumber}
            }

            if (pr.mergeable === 'CONFLICTING') {
                log.warn(`PR #${prNumber} is CONFLICTING — not merged`)
                return {merged: false, reason: 'not-mergeable', number: prNumber}
            }

            // Up-to-date enforcement (Δ L): GitHub reports BEHIND when the head is not
            // on top of the latest staging. We REFUSE and surface for the producer
            // fix-loop — no force-push, no rebase-publish (global rule). The producer
            // re-syncs and we retry on a later turn.
            if (pr.mergeStateStatus === 'BEHIND') {
                log.warn(`PR #${prNumber} head is BEHIND ${this.staging} — refusing to merge (no force-push)`)
                return {merged: false, reason: 'behind', number: prNumber}
            }

            // Probe for native merge-queue (optional upgrade). When present, enqueue via
            // --auto and let GitHub serialize. Otherwise app-level squash-merge now. The
            // probe THROWS on a "couldn't tell" gh failure (auth/rate-limit/5xx); CONTAIN
            // it here — log and degrade to app-level squash rather than letting it crash
            // `factory next-action` (which catches only UsageError, so a bare throw would WEDGE
            // the run). The degrade is benign: both paths squash-merge, only --auto differs.
            let hasMergeQueue = false
            try {
                hasMergeQueue = await this.ghClient.mergeQueueProbe(this.owner, this.repo, this.staging)
            } catch (err) {
                const detail = err instanceof Error ? err.message : String(err)
                log.warn(`merge-queue probe failed (${detail}) — falling back to app-level squash`)
            }
            if (hasMergeQueue) {
                await this.ghClient.prMergeSquash(prNumber, {auto: true, deleteBranch: true})
                log.info(`PR #${prNumber} enqueued via native merge-queue`)
                return {merged: true, via: 'merge-queue', number: prNumber}
            }

            // Squash-merge NOW, then delete ONLY the remote head ref. We deliberately do
            // NOT pass --delete-branch: gh would also `git branch -D` the local branch,
            // which the per-task worktree holds checked-out (preflight `checkout -B`), so
            // that delete fails and takes the already-succeeded merge down with it
            // (exit 1). Splitting the remote-ref delete out keeps the merge worktree-safe;
            // the local branch/worktree are ephemeral data-dir state torn down with the run.
            await this.ghClient.prMergeSquash(prNumber, {})
            log.info(`PR #${prNumber} squash-merged into ${this.staging} (app-level serial)`)
            await this.deleteMergedHeadBestEffort(pr.headRefName)
            return {merged: true, via: 'app-level', number: prNumber}
        })
    }

    /**
     * Delete the merged PR's remote head ref — BEST EFFORT. The squash-merge has
     * already landed, so a failed delete is cosmetic (a leaked remote branch): WARN
     * and continue, never throw. A throw here would turn the merge success into an
     * exception and, on the sanctioned `drive` retry, re-enter the MERGED branch and
     * fail on the SAME delete again — a wedge. (Contrast the cancel `--cleanup` path,
     * which surfaces this loudly: there the ref teardown IS the whole operation.)
     */
    private async deleteMergedHeadBestEffort(headRefName: string): Promise<void> {
        try {
            await this.ghClient.deleteRemoteBranch(this.owner, this.repo, headRefName)
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err)
            log.warn(
                `post-merge cleanup: failed to delete remote head ref '${headRefName}' ` +
                    `(merge already landed — leaked ref is cosmetic): ${detail}`
            )
        }
    }
}
