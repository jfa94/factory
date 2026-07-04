/**
 * WS3 — typed GhClient over an injectable {@link GhRunner}.
 *
 * Narrow `gh` surface for idempotent PR create (Δ P), serial merge (Δ L), and the
 * branch-protection probe (#2 / Δ A). Every JSON read goes through
 * {@link parseGhJson}, which FAILS LOUD when `ExecResult.truncated === true`
 * (reusing the frozen exec seam) — a clipped `gh --json` payload must NEVER be
 * silently mis-parsed into a wrong control-flow decision (e.g. "no PR exists" →
 * duplicate create).
 */
import {z} from 'zod'
import type {ExecOptions, ExecResult} from '../shared/index.js'
import {createLogger, parseJson} from '../shared/index.js'
import {defaultGhRunner, runOrThrow, type GhRunner} from './exec-tools.js'

const log = createLogger('gh')

/** A pull request as returned by `gh pr list/view --json`. */
export interface PullRequest {
    number: number
    headRefName: string
    baseRefName: string
    state: 'OPEN' | 'CLOSED' | 'MERGED'
    /** GitHub mergeable status (MERGEABLE | CONFLICTING | UNKNOWN), if requested. */
    mergeable?: string | undefined
    /** Merge-state status (CLEAN | BEHIND | BLOCKED | DIRTY | ...), if requested. */
    mergeStateStatus?: string | undefined
    url?: string | undefined
}

/** Result of {@link GhClient.prCreate}. */
export interface CreatedPr {
    number: number
    url: string
}

/**
 * Aggregate state of a PR's CI checks (the "ONE full-CI gate", §④). `none` means
 * the PR has NO checks configured (a normal answer — the rollup proceeds, there is
 * nothing to gate); `pending` means at least one check is still running.
 */
export type ChecksState = 'passing' | 'pending' | 'failing' | 'none'

/** Branch-protection facts as the probe reads them (raw GET shape, narrowed). */
export interface ProtectionApiResult {
    /** Whether a protection record exists at all (404 → false). */
    enabled: boolean
    /** Required status-check contexts (may be empty). */
    requiredStatusChecks: string[]
    /** `required_status_checks.strict` — branches must be up-to-date before merge. */
    strictUpToDate: boolean
    /** Whether native GitHub merge-queue is configured for this branch. */
    hasMergeQueue: boolean
}

/** Args for {@link GhClient.prList}. */
export interface PrListArgs {
    head: string
    base?: string
    state?: 'open' | 'closed' | 'merged' | 'all'
}

/** Args for {@link GhClient.prCreate}. */
export interface PrCreateArgs {
    base: string
    head: string
    title: string
    body: string
}

/** Options for {@link GhClient.prMergeSquash}. */
export interface PrMergeOptions {
    deleteBranch?: boolean
    /** Enqueue via merge-queue/auto rather than merge now (probe-detected upgrade). */
    auto?: boolean
    /**
     * Override the squash-merge commit subject. The rollup passes the plain run title
     * here (develop only ever receives a COMPLETE run — Decision 34), so the develop
     * history records the run that shipped.
     */
    subject?: string
    /** Override the squash-merge commit body. */
    body?: string
}

/** Per-call gh options. */
export interface GhOpts {
    cwd?: string
}

/** The typed `gh` surface WS3 depends on. */
export interface GhClient {
    /** `gh pr list --head <head> [--base] [--state] --json ...` (Δ P lookup). */
    prList(args: PrListArgs, opts?: GhOpts): Promise<PullRequest[]>
    /** `gh pr create ...` → {number, url}. */
    prCreate(args: PrCreateArgs, opts?: GhOpts): Promise<CreatedPr>
    /** `gh pr view <number> --json <fields>`. */
    prView(number: number, fields: readonly string[], opts?: GhOpts): Promise<PullRequest>
    /** `gh pr checks <number> --json bucket` aggregated to a single CI state (§④ gate). */
    prChecks(number: number, opts?: GhOpts): Promise<ChecksState>
    /** `gh pr merge <number> --squash [--auto] [--delete-branch]` (Δ L action). */
    prMergeSquash(number: number, opts?: PrMergeOptions & GhOpts): Promise<void>
    /** GET branch-protection via `gh api` (probe; 404 → not enabled). */
    repoProtection(owner: string, repo: string, branch: string, opts?: GhOpts): Promise<ProtectionApiResult>
    /** PUT branch-protection via `gh api` (--provision ONLY). */
    putProtection(owner: string, repo: string, branch: string, body: ProtectionPutBody, opts?: GhOpts): Promise<void>
    /** Detect whether native GitHub merge-queue is available for this branch. */
    mergeQueueProbe(owner: string, repo: string, branch: string, opts?: GhOpts): Promise<boolean>
    /**
     * Delete ONLY the remote head ref via the API (`DELETE /git/refs/heads/<branch>`).
     * Never touches the local branch — a per-task worktree holds it checked-out, so
     * `git branch -D` would fail (that is exactly why `gh pr merge --delete-branch`
     * cannot be used). Idempotent: a missing ref is success, not an error.
     */
    deleteRemoteBranch(owner: string, repo: string, branch: string, opts?: GhOpts): Promise<void>
    /** DELETE branch protection (`gh api -X DELETE …/branches/<branch>/protection`). 404 → success. */
    deleteProtection(owner: string, repo: string, branch: string, opts?: GhOpts): Promise<void>
    /** `gh issue comment <number> --repo <repo> --body <body>` (PRD delivered + failure comments). */
    issueComment(args: {repo: string; number: number; body: string}, opts?: GhOpts): Promise<void>
    /**
     * `gh issue view <number> --repo <repo> --json comments` → existing comment bodies.
     * The finalize failure-comment dedup lookup (scan for the run's marker).
     */
    listIssueComments(args: {repo: string; number: number}, opts?: GhOpts): Promise<string[]>
    /** `gh issue close <number> --repo <repo> [--comment <comment>]` (close PRD on completion). */
    issueClose(args: {repo: string; number: number; comment?: string}, opts?: GhOpts): Promise<void>
}

/** Body for a branch-protection PUT (the subset WS3 sets). */
export interface ProtectionPutBody {
    requiredStatusChecks: string[]
    strict: boolean
}

// ---------------------------------------------------------------------------
// Zod shapes for the gh JSON payloads (LOUD on a wrong shape).
// ---------------------------------------------------------------------------

const PullRequestSchema = z.object({
    number: z.number().int(),
    headRefName: z.string(),
    baseRefName: z.string(),
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
    mergeable: z.string().optional(),
    mergeStateStatus: z.string().optional(),
    url: z.string().optional(),
})

/**
 * The fields `prView` MUST always request: every NON-optional key of
 * {@link PullRequestSchema}. `gh pr view --json <subset>` returns ONLY the
 * requested fields, so a caller asking for just a subset (e.g. the rollup wants
 * `state,mergeable`) would otherwise leave `headRefName`/`baseRefName`/`state`
 * absent and make the strict {@link parseGhJson} throw. prView unions these into
 * every query so its guarantee always matches the schema. Derived FROM the schema
 * so the two can never drift (add a required field → it's auto-requested).
 */
const REQUIRED_VIEW_FIELDS: readonly string[] = Object.entries(PullRequestSchema.shape)
    .filter(([, schema]) => !schema.isOptional())
    .map(([key]) => key)

/**
 * Aggregate `gh pr checks --json bucket` rows into one {@link ChecksState}. A
 * single failing/cancelled check fails the gate; any pending check holds it;
 * otherwise (pass/skipping) it passes. An empty set is `none` (no checks).
 */
export function aggregateChecks(rows: readonly {bucket?: string | undefined}[]): ChecksState {
    if (rows.length === 0) {
        return 'none'
    }
    const buckets = rows.map((r) => (r.bucket ?? '').toLowerCase())
    if (buckets.some((b) => b === 'fail' || b === 'cancel')) {
        return 'failing'
    }
    if (buckets.some((b) => b === 'pending')) {
        return 'pending'
    }
    return 'passing'
}

/** `gh pr checks --json bucket` rows — only `bucket` is read. */
const GhChecksSchema = z.array(z.object({bucket: z.string().optional()}))

/** `gh api …/branches/…/protection` — only the fields the protection read consumes. */
const GhProtectionSchema = z.object({
    required_status_checks: z
        .object({strict: z.boolean().optional(), contexts: z.array(z.string()).optional()})
        .nullish(),
})

/** `gh api …/rules/branches/…` ruleset rows — only `type` is read. */
const GhRulesSchema = z.array(z.object({type: z.string().optional()}))

/**
 * Parse a `gh --json` payload, FAILING LOUD on truncation. A clipped payload is
 * never parsed: a half-read JSON array would either throw a confusing JSON error
 * or — worse — parse to a wrong-but-valid prefix and drive a bad decision.
 */
export function parseGhJson<T>(result: ExecResult, schema: z.ZodType<T>, where: string): T {
    if (result.truncated) {
        throw new Error(
            `gh: output of '${where}' was TRUNCATED (hit maxBuffer) — refusing to parse a clipped JSON payload`
        )
    }
    const raw = parseJson(result.stdout, where)
    return schema.parse(raw)
}

/** Default GhClient over the real (or an injected) gh runner. */
export class DefaultGhClient implements GhClient {
    private readonly runner: GhRunner

    constructor(runner: GhRunner = defaultGhRunner) {
        this.runner = runner
    }

    private execOpts(opts?: GhOpts): ExecOptions {
        const cwd = opts?.cwd
        return cwd != null && cwd.length > 0 ? {cwd} : {}
    }

    async prList(args: PrListArgs, opts?: GhOpts): Promise<PullRequest[]> {
        const argv = [
            'pr',
            'list',
            '--head',
            args.head,
            '--state',
            args.state ?? 'open',
            '--json',
            'number,headRefName,baseRefName,state,mergeable,mergeStateStatus,url',
        ]
        if (args.base != null && args.base.length > 0) {
            argv.push('--base', args.base)
        }
        const r = await runOrThrow('gh', this.runner, argv, this.execOpts(opts))
        return parseGhJson(r, z.array(PullRequestSchema), 'gh pr list')
    }

    async prCreate(args: PrCreateArgs, opts?: GhOpts): Promise<CreatedPr> {
        // `gh pr create` prints the PR URL to stdout. Use --json on view afterwards
        // would need a number; instead create then parse the URL it emits.
        const r = await runOrThrow(
            'gh',
            this.runner,
            ['pr', 'create', '--base', args.base, '--head', args.head, '--title', args.title, '--body', args.body],
            this.execOpts(opts)
        )
        if (r.truncated) {
            throw new Error('gh pr create: output truncated — cannot trust the emitted PR URL')
        }
        const url = r.stdout.trim().split(/\s+/).pop() ?? ''
        const m = /\/pull\/(\d+)\s*$/.exec(url)
        if (!m) {
            throw new Error(`gh pr create: could not parse PR number from output: ${r.stdout.trim()}`)
        }
        return {number: Number(m[1]), url}
    }

    async prView(number: number, fields: readonly string[], opts?: GhOpts): Promise<PullRequest> {
        // Always request the schema's required fields (REQUIRED_VIEW_FIELDS): a caller
        // may pass only a subset (e.g. the rollup wants state+mergeable), but the strict
        // parse needs number+headRefName+baseRefName+state present or it throws.
        const requested = Array.from(new Set([...REQUIRED_VIEW_FIELDS, ...fields]))
        const r = await runOrThrow(
            'gh',
            this.runner,
            ['pr', 'view', String(number), '--json', requested.join(',')],
            this.execOpts(opts)
        )
        return parseGhJson(r, PullRequestSchema, 'gh pr view')
    }

    async prChecks(number: number, opts?: GhOpts): Promise<ChecksState> {
        const r = await this.runner(['pr', 'checks', String(number), '--json', 'bucket'], this.execOpts(opts))
        if (r.truncated) {
            throw new Error('gh pr checks: output truncated — refusing to parse clipped checks JSON')
        }
        const stdout = r.stdout.trim()
        if (stdout === '' || stdout === '[]') {
            // No checks: gh either prints an empty array, or exits non-zero with
            // "no checks reported". Both mean the gate has nothing to enforce. A
            // different non-zero (auth/network) is a real failure → throw.
            if (r.code !== 0 && !/no checks reported/i.test(r.stderr)) {
                throw new Error(`gh pr checks #${number} failed (code=${r.code ?? 'null'}): ${r.stderr.trim()}`)
            }
            return 'none'
        }
        const rows = GhChecksSchema.parse(parseJson(stdout, 'gh pr checks'))
        return aggregateChecks(rows)
    }

    async prMergeSquash(number: number, opts?: PrMergeOptions & GhOpts): Promise<void> {
        const argv = ['pr', 'merge', String(number), '--squash']
        if (opts?.auto === true) {
            argv.push('--auto')
        }
        if (opts?.deleteBranch === true) {
            argv.push('--delete-branch')
        }
        if (opts?.subject !== undefined) {
            argv.push('--subject', opts.subject)
        }
        if (opts?.body !== undefined) {
            argv.push('--body', opts.body)
        }
        await runOrThrow('gh', this.runner, argv, this.execOpts(opts))
    }

    async deleteRemoteBranch(owner: string, repo: string, branch: string, opts?: GhOpts): Promise<void> {
        // Remote-ref delete via the API — never `git branch -D` (a worktree holds the
        // local branch). Idempotent: a 422 "Reference does not exist" / 404 means the
        // ref is already gone (success). Any other non-zero is a real error → throw.
        const path = `repos/${owner}/${repo}/git/refs/heads/${branch}`
        const r = await this.runner(['api', '--method', 'DELETE', path], this.execOpts(opts))
        if (r.code !== 0 && !/Reference does not exist|404|Not Found|422/i.test(r.stderr)) {
            throw new Error(`gh api DELETE ${path} failed (code=${r.code ?? 'null'}): ${r.stderr.trim()}`)
        }
    }

    async deleteProtection(owner: string, repo: string, branch: string, opts?: GhOpts): Promise<void> {
        const argv = ['api', '-X', 'DELETE', `/repos/${owner}/${repo}/branches/${branch}/protection`]
        const r = await this.runner(argv, this.execOpts(opts))
        // A 404 / "Branch not protected" is the ANSWER (the branch had no protection, or was
        // already deleted by a prior finalize), not an error — mirror repoProtection. Any OTHER
        // non-zero (403 no-admin, 5xx, network) is a real failure → throw, so an auth/permission
        // failure is never silently masked as "already gone".
        if (r.code !== 0 && !/404|Not Found|Branch not protected/i.test(r.stderr)) {
            throw new Error(`gh api DELETE protection failed for ${owner}/${repo}@${branch}: ${r.stderr}`)
        }
    }

    async issueComment(args: {repo: string; number: number; body: string}, opts?: GhOpts): Promise<void> {
        const argv = ['issue', 'comment', String(args.number), '--repo', args.repo, '--body', args.body]
        await runOrThrow('gh', this.runner, argv, this.execOpts(opts))
    }

    async listIssueComments(args: {repo: string; number: number}, opts?: GhOpts): Promise<string[]> {
        const r = await runOrThrow(
            'gh',
            this.runner,
            ['issue', 'view', String(args.number), '--repo', args.repo, '--json', 'comments'],
            this.execOpts(opts)
        )
        const parsed = parseGhJson(
            r,
            z.object({comments: z.array(z.object({body: z.string()}))}),
            'gh issue view comments'
        )
        return parsed.comments.map((c) => c.body)
    }

    async issueClose(args: {repo: string; number: number; comment?: string}, opts?: GhOpts): Promise<void> {
        const argv = ['issue', 'close', String(args.number), '--repo', args.repo]
        if (args.comment !== undefined) {
            argv.push('--comment', args.comment)
        }
        await runOrThrow('gh', this.runner, argv, this.execOpts(opts))
    }

    async repoProtection(owner: string, repo: string, branch: string, opts?: GhOpts): Promise<ProtectionApiResult> {
        const path = `repos/${owner}/${repo}/branches/${branch}/protection`
        const r = await this.runner(['api', path], this.execOpts(opts))
        // A 404 (no protection) is the ANSWER, not an error: gh exits non-zero. Only
        // a real failure (auth, network) should throw — distinguish by stderr.
        if (r.code !== 0) {
            if (/404|Not Found|Branch not protected/i.test(r.stderr)) {
                return {
                    enabled: false,
                    requiredStatusChecks: [],
                    strictUpToDate: false,
                    hasMergeQueue: false,
                }
            }
            throw new Error(`gh api ${path} failed (code=${r.code ?? 'null'}): ${r.stderr.trim()}`)
        }
        if (r.truncated) {
            throw new Error(`gh api ${path}: output truncated — refusing to parse clipped protection JSON`)
        }
        const raw = GhProtectionSchema.parse(parseJson(r.stdout, path))
        const rsc = raw.required_status_checks ?? null
        // hasMergeQueue is ADVISORY metadata here — no consumer reads it for a decision
        // (the merge path re-probes via the serial writer). The probe now throws on a
        // "couldn't tell" gh failure; CONTAIN it so a transient ruleset-API blip can't
        // make this preflight protection read fail-loud and refuse the run.
        let mq = false
        try {
            mq = await this.mergeQueueProbe(owner, repo, branch, opts)
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err)
            log.warn(`merge-queue probe failed during protection read (${detail}) — assuming no queue`)
        }
        return {
            enabled: true,
            requiredStatusChecks: rsc?.contexts ?? [],
            strictUpToDate: rsc?.strict === true,
            hasMergeQueue: mq,
        }
    }

    async putProtection(
        owner: string,
        repo: string,
        branch: string,
        body: ProtectionPutBody,
        opts?: GhOpts
    ): Promise<void> {
        const path = `repos/${owner}/${repo}/branches/${branch}/protection`
        const payload = JSON.stringify({
            required_status_checks: {
                strict: body.strict,
                contexts: body.requiredStatusChecks,
            },
            enforce_admins: true,
            required_pull_request_reviews: null,
            restrictions: null,
        })
        log.info(`provisioning branch protection for ${owner}/${repo}@${branch}`)
        await runOrThrow('gh', this.runner, ['api', '--method', 'PUT', path, '--input', '-'], {
            ...this.execOpts(opts),
            input: payload,
        })
    }

    async mergeQueueProbe(owner: string, repo: string, branch: string, opts?: GhOpts): Promise<boolean> {
        // Detect a native merge-queue rule via the branch rulesets API. A 404 / Not
        // Found (no ruleset record for the branch) is the GENUINE negative → false. Any
        // OTHER non-zero exit (auth, rate-limit, 5xx) or a truncated body means
        // "couldn't tell" — THROW rather than lie "absent", so the caller degrades
        // observably instead of silently downgrading off a real native merge queue
        // (mirrors repoProtection). A successfully-fetched but oddly-shaped 200 body is
        // a real negative (no merge_queue rule) → false.
        const path = `repos/${owner}/${repo}/rules/branches/${branch}`
        const r = await this.runner(['api', path], this.execOpts(opts))
        if (r.code !== 0) {
            if (/404|Not Found/i.test(r.stderr)) {
                return false
            }
            throw new Error(`gh api ${path} failed (code=${r.code ?? 'null'}): ${r.stderr.trim()}`)
        }
        if (r.truncated) {
            throw new Error(`gh api ${path}: output truncated — refusing to parse clipped ruleset JSON`)
        }
        // Unparseable JSON in a 200 body means "couldn't tell" — parseJson throws
        // rather than silently return false and mask a real native merge queue. A
        // parseable-but-oddly-shaped body (not the ruleset array) is a real negative:
        // safeParse fails → false (mirrors comment above).
        const rules = GhRulesSchema.safeParse(parseJson(r.stdout, path))
        return rules.success && rules.data.some((rule) => rule.type === 'merge_queue')
    }
}
