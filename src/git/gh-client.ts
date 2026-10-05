/**
 * WS3 — typed GhClient over an injectable {@link GhRunner}.
 *
 * Narrow `gh` surface for the branch-protection probe and provisioning (#2 / Δ A).
 * JSON reads FAIL LOUD when `ExecResult.truncated === true` (see {@link parseGhJson})
 * — a clipped `gh --json` payload must NEVER be silently mis-parsed into a wrong
 * control-flow decision.
 */
import {z} from 'zod'
import type {ExecOptions, ExecResult} from '../shared/index.js'
import {createLogger, parseJson} from '../shared/index.js'
import {defaultGhRunner, runOrThrow, type GhRunner} from './exec-tools.js'

const log = createLogger('gh')

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

/** Per-call gh options. */
export interface GhOpts {
    cwd?: string
}

/** The typed `gh` surface WS3 depends on. */
export interface GhClient {
    /** GET branch-protection via `gh api` (probe; 404 → not enabled). */
    repoProtection(owner: string, repo: string, branch: string, opts?: GhOpts): Promise<ProtectionApiResult>
    /** PUT branch-protection via `gh api` (--provision ONLY). */
    putProtection(owner: string, repo: string, branch: string, body: ProtectionPutBody, opts?: GhOpts): Promise<void>
    /** Add required checks without replacing review, restriction, admin or deletion policy. */
    strengthenStatusChecks?(
        owner: string,
        repo: string,
        branch: string,
        contexts: readonly string[],
        opts?: GhOpts
    ): Promise<void>
    /** Detect whether native GitHub merge-queue is available for this branch. */
    mergeQueueProbe(owner: string, repo: string, branch: string, opts?: GhOpts): Promise<boolean>
}

/** Body for a branch-protection PUT (the subset WS3 sets). */
export interface ProtectionPutBody {
    requiredStatusChecks: string[]
    strict: boolean
    /**
     * `enforce_admins` — apply the rules to repo admins too. Defaults TRUE (the
     * run/staging profiles). Develop's baseline profile (D74) sets FALSE so
     * admins can push straight to develop between runs.
     */
    enforceAdmins?: boolean
}

// ---------------------------------------------------------------------------
// Zod shapes for the gh JSON payloads (LOUD on a wrong shape).
// ---------------------------------------------------------------------------

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

/** Uniform Error for a non-zero `gh api <path>` exit — shared by the protection reads. */
function ghApiFailure(path: string, r: ExecResult): Error {
    return new Error(`gh api ${path} failed (code=${r.code ?? 'null'}): ${r.stderr.trim()}`)
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
            throw ghApiFailure(path, r)
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

    async strengthenStatusChecks(
        owner: string,
        repo: string,
        branch: string,
        contexts: readonly string[],
        opts?: GhOpts
    ): Promise<void> {
        const path = `repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`
        const current = await runOrThrow('gh', this.runner, ['api', path], this.execOpts(opts))
        const state = parseGhJson(
            current,
            z.object({checks: z.array(z.object({context: z.string(), app_id: z.number().nullable()}))}),
            'required status checks'
        )
        const checks = [...state.checks]
        for (const context of contexts) {
            if (!checks.some((check) => check.context === context)) {
                checks.push({context, app_id: -1})
            }
        }
        await runOrThrow('gh', this.runner, ['api', '--method', 'PATCH', path, '--input', '-'], {
            ...this.execOpts(opts),
            input: JSON.stringify({strict: true, checks}),
        })
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
            enforce_admins: body.enforceAdmins ?? true,
            required_pull_request_reviews: null,
            restrictions: null,
            // D55: GitHub defaults allow_deletions to FALSE, which made every leftover
            // per-run staging branch undeletable by hand until its protection rule was
            // torn down via the API. The plugin never relies on deletion-blocking (its
            // own teardown always deletes protection first), so keep leftovers deletable.
            allow_deletions: true,
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
            throw ghApiFailure(path, r)
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
