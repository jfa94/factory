/**
 * WS5 — injectable `gh` wrapper for PRD fetch.
 *
 * The real implementation shells `gh issue view <n> --json …` through the frozen
 * `src/shared/exec` seam; the {@link GhClient} interface lets the pipeline unit
 * test WITHOUT the real binary (inject a fake). External CLIs are always wrapped,
 * never bundled.
 *
 * Loud failures (Decision: no silent degradation):
 *   - `gh` not authenticated  → {@link GhAuthError} (distinct, actionable).
 *   - issue not found          → {@link IssueNotFoundError} (distinct).
 *   - truncated JSON output    → throw (never parse a clipped payload).
 *   - any other non-zero exit  → throw with the captured stderr.
 */
import {exec} from '../shared/exec.js'
import type {ExecResult} from '../shared/exec.js'
import {parseJson} from '../shared/json.js'
import {createLogger} from '../shared/logging.js'
import {SPEC_DEFAULTS} from '../config/index.js'

const log = createLogger('spec:gh')

/** A parsed PRD issue. */
export interface Prd {
    issue_number: number
    title: string
    body: string
    labels: string[]
    /** True iff the body was clipped to the byte cap. */
    body_truncated: boolean
}

/** The injectable PRD-fetch boundary. */
export interface GhClient {
    fetchPrd(issueNumber: number, opts?: {repo?: string}): Promise<Prd>
}

/** `gh` is not authenticated / not logged in. */
export class GhAuthError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'GhAuthError'
    }
}

/** The requested issue does not exist (or is not visible). */
export class IssueNotFoundError extends Error {
    readonly issueNumber: number
    constructor(issueNumber: number, message: string) {
        super(message)
        this.name = 'IssueNotFoundError'
        this.issueNumber = issueNumber
    }
}

/** Signature of the injectable exec fn (matches the frozen `exec`). */
export type ExecFn = (command: string, args?: readonly string[], opts?: {timeoutMs?: number}) => Promise<ExecResult>

/** Shape of the `gh issue view --json` payload we request. */
interface GhIssueJson {
    number?: unknown
    title?: unknown
    body?: unknown
    labels?: unknown
}

const AUTH_HINT = /not logged|gh auth login|authentication|HTTP 401|requires authentication/i
const NOT_FOUND_HINT = /could not resolve to|not found|HTTP 404|no issue|GraphQL: Could not/i

/**
 * Real {@link GhClient}. `exec` is injected (defaults to the frozen seam) so the
 * unit tests can drive it with a fake that never spawns the real binary.
 */
export class RealGhClient implements GhClient {
    private readonly exec: ExecFn
    private readonly bodyMaxBytes: number

    constructor(opts: {exec?: ExecFn; bodyMaxBytes?: number} = {}) {
        this.exec = opts.exec ?? exec
        this.bodyMaxBytes = opts.bodyMaxBytes ?? SPEC_DEFAULTS.prdBodyMaxBytes
    }

    async fetchPrd(issueNumber: number, opts: {repo?: string} = {}): Promise<Prd> {
        if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
            throw new Error(`fetchPrd: issue number must be a positive integer, got ${issueNumber}`)
        }

        const args = ['issue', 'view', String(issueNumber), '--json', 'number,title,body,labels']
        if (opts.repo != null && opts.repo.length > 0) {
            args.push('--repo', opts.repo)
        }

        const result = await this.exec('gh', args, {timeoutMs: 30_000})

        if (result.code !== 0) {
            const stderr = result.stderr.trim()
            if (AUTH_HINT.test(stderr)) {
                throw new GhAuthError(`gh is not authenticated (run \`gh auth login\`): ${stderr}`)
            }
            if (NOT_FOUND_HINT.test(stderr)) {
                throw new IssueNotFoundError(
                    issueNumber,
                    `issue #${issueNumber} not found${opts.repo != null && opts.repo.length > 0 ? ` in ${opts.repo}` : ''}: ${stderr}`
                )
            }
            throw new Error(`gh issue view #${issueNumber} failed (code=${result.code ?? 'null'}): ${stderr}`)
        }

        if (result.truncated) {
            // A clipped JSON payload would mis-parse; fail loud rather than guess.
            throw new Error(`gh issue view #${issueNumber} output was truncated; cannot parse a clipped payload`)
        }

        // External gh JSON: parse to `unknown`, then confirm it's an object. Every field
        // below is read through its own `typeof`/`Array.isArray` guard (all GhIssueJson
        // fields are `unknown`), so this narrow — not a trusted cast — is the validation.
        const raw = parseJson(result.stdout, `gh issue #${issueNumber}`)
        const parsed: GhIssueJson = raw !== null && typeof raw === 'object' ? raw : {}

        const title = typeof parsed.title === 'string' ? parsed.title : ''
        if (title.length === 0) {
            throw new Error(`gh issue view #${issueNumber}: missing or empty title in response`)
        }

        const rawBody = typeof parsed.body === 'string' ? parsed.body : ''
        const {body, body_truncated} = this.capBody(rawBody)
        if (body_truncated) {
            log.warn(`PRD body for issue #${issueNumber} exceeded ${this.bodyMaxBytes} bytes; truncated`)
        }

        const labels = Array.isArray(parsed.labels)
            ? parsed.labels
                  .map((l: unknown) =>
                      l != null && typeof l === 'object' && 'name' in l && typeof l.name === 'string'
                          ? l.name
                          : typeof l === 'string'
                            ? l
                            : null
                  )
                  .filter((l): l is string => l !== null)
            : []

        return {
            issue_number: issueNumber,
            title,
            body,
            labels,
            body_truncated,
        }
    }

    /** Cap the body to `bodyMaxBytes` on a UTF-8 byte boundary. */
    private capBody(body: string): {body: string; body_truncated: boolean} {
        const buf = Buffer.from(body, 'utf8')
        if (buf.length <= this.bodyMaxBytes) {
            return {body, body_truncated: false}
        }
        // Slice on a byte boundary, then decode tolerantly (a clipped multibyte char
        // is dropped by toString rather than producing a replacement run mid-stream).
        const clipped = buf.subarray(0, this.bodyMaxBytes).toString('utf8')
        return {body: clipped, body_truncated: true}
    }
}
