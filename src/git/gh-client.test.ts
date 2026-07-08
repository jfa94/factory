import {describe, expect, it} from 'vitest'
import {z} from 'zod'
import {aggregateChecks, DefaultGhClient, parseGhJson} from './gh-client.js'
import type {ExecResult} from '../shared/index.js'
import type {GhRunner} from './exec-tools.js'

function result(over: Partial<ExecResult>): ExecResult {
    return {stdout: '', stderr: '', code: 0, signal: null, truncated: false, ...over}
}

describe('gh truncation safety (reuses ExecResult.truncated seam)', () => {
    it('parseGhJson FAILS LOUD when truncated, rather than parsing a clipped payload', () => {
        const clipped = result({stdout: '[{"number":1,', truncated: true})
        expect(() => parseGhJson(clipped, z.array(z.unknown()), 'gh pr list')).toThrow(/TRUNCATED/)
    })

    it("prList throws on a truncated payload (would otherwise mis-read 'no PR exists')", async () => {
        const runner: GhRunner = () =>
            Promise.resolve(result({stdout: '[{"number":1,"headRefName":"b",', truncated: true}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.prList({head: 'factory/run-1/t1'})).rejects.toThrow(/TRUNCATED/)
    })

    it('prList parses a well-formed payload when not truncated', async () => {
        const runner: GhRunner = () =>
            Promise.resolve(
                result({
                    stdout: JSON.stringify([
                        {
                            number: 5,
                            headRefName: 'factory/run-1/t1',
                            baseRefName: 'staging',
                            state: 'OPEN',
                        },
                    ]),
                })
            )
        const gh = new DefaultGhClient(runner)
        const prs = await gh.prList({head: 'factory/run-1/t1'})
        expect(prs).toHaveLength(1)
        expect(prs[0]?.number).toBe(5)
    })

    it('prList emits --repo when given and parses mergeCommit (reconcile facts)', async () => {
        let captured: readonly string[] = []
        const runner: GhRunner = (args) => {
            captured = args
            return Promise.resolve(
                result({
                    stdout: JSON.stringify([
                        {
                            number: 7,
                            headRefName: 'factory/run-1/t1',
                            baseRefName: 'staging-run-1',
                            state: 'MERGED',
                            mergeCommit: {oid: 'deadbeef'},
                        },
                    ]),
                })
            )
        }
        const gh = new DefaultGhClient(runner)
        const prs = await gh.prList({head: 'factory/run-1/t1', state: 'all', repo: 'acme/widgets'})
        expect(captured).toContain('--repo')
        expect(captured).toContain('acme/widgets')
        expect(captured.some((a) => a.includes('mergeCommit'))).toBe(true)
        expect(prs[0]?.mergeCommit?.oid).toBe('deadbeef')
    })

    it('repoProtection maps a 404 to enabled:false (a normal answer, not an error)', async () => {
        const runner: GhRunner = (args) => {
            // protection endpoint → 404; rulesets endpoint → also absent
            if (args.includes('rules')) {
                return Promise.resolve(result({code: 1, stderr: 'Not Found (404)'}))
            }
            return Promise.resolve(result({code: 1, stderr: 'HTTP 404: Branch not protected'}))
        }
        const gh = new DefaultGhClient(runner)
        const state = await gh.repoProtection('o', 'r', 'staging')
        expect(state.enabled).toBe(false)
        expect(state.strictUpToDate).toBe(false)
    })

    it("repoProtection throws on a non-404 failure (auth/network is NOT silently 'unprotected')", async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 401: Bad credentials'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.repoProtection('o', 'r', 'staging')).rejects.toThrow(/401|failed/i)
    })

    it("deleteProtection swallows a 'Branch not protected' 404 (already-unprotected is the answer)", async () => {
        const runner: GhRunner = () =>
            Promise.resolve(result({code: 1, stderr: 'HTTP 404: Branch not protected (https://docs.github.com/...)'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.deleteProtection('o', 'r', 'staging/run-1')).resolves.toBeUndefined()
    })

    it('deleteProtection throws on a genuine failure (auth) — never masked as already-gone', async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 401: Bad credentials'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.deleteProtection('o', 'r', 'staging/run-1')).rejects.toThrow(/401|failed/i)
    })

    it('prCreate parses the PR number from the emitted URL', async () => {
        const runner: GhRunner = (args) => {
            expect(args[0]).toBe('pr')
            expect(args[1]).toBe('create')
            return Promise.resolve(result({stdout: 'https://github.com/o/r/pull/123\n'}))
        }
        const gh = new DefaultGhClient(runner)
        const created = await gh.prCreate({base: 'staging', head: 'b', title: 't', body: 'b'})
        expect(created.number).toBe(123)
    })
})

describe("mergeQueueProbe (Theme D1 — distinguishes 'no queue' from 'couldn't tell')", () => {
    it('returns true when a native merge_queue rule applies to the branch', async () => {
        const runner: GhRunner = () =>
            Promise.resolve(result({stdout: JSON.stringify([{type: 'pull_request'}, {type: 'merge_queue'}])}))
        const gh = new DefaultGhClient(runner)
        expect(await gh.mergeQueueProbe('o', 'r', 'staging')).toBe(true)
    })

    it('returns false on a 200 body with no merge_queue rule (the genuine negative)', async () => {
        const runner: GhRunner = () => Promise.resolve(result({stdout: JSON.stringify([{type: 'pull_request'}])}))
        const gh = new DefaultGhClient(runner)
        expect(await gh.mergeQueueProbe('o', 'r', 'staging')).toBe(false)
    })

    it('maps a 404 / Not Found to false (no ruleset record is a normal answer)', async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 404: Not Found'}))
        const gh = new DefaultGhClient(runner)
        expect(await gh.mergeQueueProbe('o', 'r', 'staging')).toBe(false)
    })

    it("THROWS on a non-404 failure (auth) — a transient blip must NOT read as 'no queue'", async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 401: Bad credentials'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.mergeQueueProbe('o', 'r', 'staging')).rejects.toThrow(/401|failed/i)
    })

    it("THROWS on a 5xx failure (server error is 'couldn't tell', not absence)", async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 503: Service Unavailable'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.mergeQueueProbe('o', 'r', 'staging')).rejects.toThrow(/503|failed/i)
    })

    it('THROWS on a truncated body rather than mis-reading the ruleset', async () => {
        const runner: GhRunner = () => Promise.resolve(result({stdout: '[{"type":"merge_q', truncated: true}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.mergeQueueProbe('o', 'r', 'staging')).rejects.toThrow(/truncated/i)
    })
})

describe('listIssueComments', () => {
    it('requests the comments field via gh issue view and returns the bodies', async () => {
        let captured: readonly string[] = []
        const runner: GhRunner = (args) => {
            captured = args
            return Promise.resolve(
                result({
                    stdout: JSON.stringify({
                        comments: [{body: 'PRD delivered'}, {body: '<!-- factory:run-failed:run-1 -->\n…'}],
                    }),
                })
            )
        }
        const gh = new DefaultGhClient(runner)
        const bodies = await gh.listIssueComments({repo: 'acme/widgets', number: 42})

        expect(captured.slice(0, 3)).toEqual(['issue', 'view', '42'])
        expect(captured).toContain('--repo')
        expect(captured[captured.indexOf('--repo') + 1]).toBe('acme/widgets')
        expect(captured).toContain('--json')
        expect(captured[captured.indexOf('--json') + 1]).toBe('comments')
        expect(bodies).toEqual(['PRD delivered', '<!-- factory:run-failed:run-1 -->\n…'])
    })

    it('throws on a non-zero exit (not silently swallowed)', async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 404: Not Found'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.listIssueComments({repo: 'acme/widgets', number: 1})).rejects.toThrow(/404|failed/i)
    })
})

describe('aggregateChecks (the ONE full-CI gate, §④)', () => {
    it('empty → none, all-pass → passing, any-pending → pending, any-fail → failing', () => {
        expect(aggregateChecks([])).toBe('none')
        expect(aggregateChecks([{bucket: 'pass'}, {bucket: 'skipping'}])).toBe('passing')
        expect(aggregateChecks([{bucket: 'pass'}, {bucket: 'pending'}])).toBe('pending')
        // a failure dominates a pending
        expect(aggregateChecks([{bucket: 'pending'}, {bucket: 'fail'}])).toBe('failing')
        expect(aggregateChecks([{bucket: 'cancel'}])).toBe('failing')
    })
})

describe('prChecks', () => {
    it('aggregates --json bucket rows to a single state', async () => {
        const runner: GhRunner = (args) => {
            expect(args.slice(0, 3)).toEqual(['pr', 'checks', '9'])
            expect(args).toContain('bucket')
            return Promise.resolve(result({stdout: JSON.stringify([{bucket: 'pass'}, {bucket: 'pending'}])}))
        }
        const gh = new DefaultGhClient(runner)
        expect(await gh.prChecks(9)).toBe('pending')
    })

    it("treats a 'no checks reported' non-zero exit as none (not an error)", async () => {
        const runner: GhRunner = () =>
            Promise.resolve(result({code: 1, stdout: '', stderr: 'no checks reported on the staging branch'}))
        const gh = new DefaultGhClient(runner)
        expect(await gh.prChecks(9)).toBe('none')
    })

    it('throws on a real (auth/network) failure with no parseable payload', async () => {
        const runner: GhRunner = () =>
            Promise.resolve(result({code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.prChecks(9)).rejects.toThrow(/401|failed/i)
    })

    it('throws on a truncated payload rather than mis-reading the gate', async () => {
        const runner: GhRunner = () => Promise.resolve(result({stdout: '[{"bucket":"pa', truncated: true}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.prChecks(9)).rejects.toThrow(/truncated/i)
    })
})

describe('prMergeSquash subject/body (rollup PARTIAL header, Δ S)', () => {
    it('passes --subject and --body when provided', async () => {
        let captured: readonly string[] = []
        const runner: GhRunner = (args) => {
            captured = args
            return Promise.resolve(result({}))
        }
        const gh = new DefaultGhClient(runner)
        await gh.prMergeSquash(9, {subject: 'PARTIAL: rollup', body: 'report'})
        expect(captured).toContain('--subject')
        expect(captured).toContain('PARTIAL: rollup')
        expect(captured).toContain('--body')
        expect(captured).toContain('report')
    })

    it('omits --subject/--body when not provided', async () => {
        let captured: readonly string[] = []
        const runner: GhRunner = (args) => {
            captured = args
            return Promise.resolve(result({}))
        }
        const gh = new DefaultGhClient(runner)
        await gh.prMergeSquash(9, {})
        expect(captured).not.toContain('--subject')
        expect(captured).not.toContain('--body')
    })
})

describe('deleteRemoteBranch (worktree-safe remote-ref delete, CP2 #11)', () => {
    it('DELETEs the remote head ref via the API (never `git branch -D`)', async () => {
        let captured: readonly string[] = []
        const runner: GhRunner = (args) => {
            captured = args
            return Promise.resolve(result({}))
        }
        const gh = new DefaultGhClient(runner)
        await gh.deleteRemoteBranch('o', 'r', 'factory/run-1/t1')
        expect(captured).toEqual(['api', '--method', 'DELETE', 'repos/o/r/git/refs/heads/factory/run-1/t1'])
    })

    it("is idempotent — a missing ref (422 'Reference does not exist') is success, not an error", async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 422: Reference does not exist'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.deleteRemoteBranch('o', 'r', 'gone')).resolves.toBeUndefined()
    })

    it('throws on a real failure (auth/network is NOT silently swallowed)', async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 401: Bad credentials'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.deleteRemoteBranch('o', 'r', 'b')).rejects.toThrow(/401|failed/i)
    })

    it("throws on a refused 422 ('Validation Failed', e.g. ruleset-protected ref) — only the benign 422 is tolerated", async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 422: Validation Failed'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.deleteRemoteBranch('o', 'r', 'b')).rejects.toThrow(/Validation Failed/)
    })
})

describe('putProtection (the --provision PUT body)', () => {
    it('sends allow_deletions:true so a leftover per-run staging branch stays hand-deletable (D55)', async () => {
        let payload: string | Uint8Array | undefined
        const runner: GhRunner = (_args, opts) => {
            payload = opts?.input
            return Promise.resolve(result({}))
        }
        const gh = new DefaultGhClient(runner)
        await gh.putProtection('acme', 'widgets', 'staging-run-1', {
            requiredStatusChecks: ['quality-gate'],
            strict: true,
        })
        const body = JSON.parse(String(payload ?? '{}')) as Record<string, unknown>
        expect(body.allow_deletions).toBe(true)
        expect(body.enforce_admins).toBe(true)
        expect(body.required_status_checks).toEqual({strict: true, contexts: ['quality-gate']})
    })
})

describe('branchExists / branchTip (read-only remote-branch probe: rescue gc D55, reconcile P1)', () => {
    it('branchExists returns true on a 200', async () => {
        const runner: GhRunner = (args) => {
            expect(args).toEqual(['api', 'repos/acme/widgets/branches/staging-run-x'])
            return Promise.resolve(result({stdout: '{"name":"staging-run-x","commit":{"sha":"abc123def"}}'}))
        }
        const gh = new DefaultGhClient(runner)
        await expect(gh.branchExists('acme', 'widgets', 'staging-run-x')).resolves.toBe(true)
    })

    it('branchTip returns the tip sha on a 200', async () => {
        const runner: GhRunner = () =>
            Promise.resolve(result({stdout: '{"name":"staging-run-x","commit":{"sha":"abc123def"}}'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.branchTip('acme', 'widgets', 'staging-run-x')).resolves.toBe('abc123def')
    })

    it('branchTip returns null on a 404 (a missing branch is the answer, not an error)', async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 404: Branch not found'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.branchTip('acme', 'widgets', 'gone')).resolves.toBeNull()
        await expect(gh.branchExists('acme', 'widgets', 'gone')).resolves.toBe(false)
    })

    it("branchTip throws on a non-404 failure (auth/network is NOT silently 'missing')", async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 401: Bad credentials'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.branchExists('acme', 'widgets', 'b')).rejects.toThrow(/401|failed/i)
    })

    it('branchTip throws on a truncated 200 body (never parses a clipped payload)', async () => {
        const runner: GhRunner = () => Promise.resolve(result({stdout: '{"commit":{"sha":"a', truncated: true}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.branchTip('acme', 'widgets', 'b')).rejects.toThrow(/truncated/i)
    })
})

describe('deleteProtection (remove branch protection before deleting a per-run staging branch)', () => {
    it('deleteProtection issues DELETE on the branch protection path and tolerates 404', async () => {
        let captured: readonly string[] = []
        const runner: GhRunner = (args) => {
            captured = args
            return Promise.resolve(result({}))
        }
        const gh = new DefaultGhClient(runner)
        await gh.deleteProtection('acme', 'widgets', 'staging/run-x')
        expect(captured).toEqual(['api', '-X', 'DELETE', '/repos/acme/widgets/branches/staging/run-x/protection'])
        // A 404/Not Found must resolve rather than throw (idempotent)
        const runner404: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'Not Found'}))
        const gh404 = new DefaultGhClient(runner404)
        await expect(gh404.deleteProtection('acme', 'widgets', 'missing')).resolves.toBeUndefined()
    })

    it('throws on a real failure (auth/network is NOT silently swallowed)', async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 401: Bad credentials'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.deleteProtection('o', 'r', 'b')).rejects.toThrow(/401|failed/i)
    })
})

describe('issueComment', () => {
    it('passes issue number, --repo, and --body to gh issue comment', async () => {
        let captured: readonly string[] = []
        const runner: GhRunner = (args) => {
            captured = args
            return Promise.resolve(result({}))
        }
        const gh = new DefaultGhClient(runner)
        await gh.issueComment({repo: 'acme/widgets', number: 42, body: 'PRD delivered'})
        expect(captured.slice(0, 3)).toEqual(['issue', 'comment', '42'])
        expect(captured).toContain('--repo')
        expect(captured[captured.indexOf('--repo') + 1]).toBe('acme/widgets')
        expect(captured).toContain('--body')
        expect(captured[captured.indexOf('--body') + 1]).toBe('PRD delivered')
    })

    it('throws on a non-zero exit (not silently swallowed)', async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 401: Bad credentials'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.issueComment({repo: 'acme/widgets', number: 1, body: 'hi'})).rejects.toThrow(/401|failed/i)
    })
})

describe('issueClose', () => {
    it('passes issue number and --repo to gh issue close', async () => {
        let captured: readonly string[] = []
        const runner: GhRunner = (args) => {
            captured = args
            return Promise.resolve(result({}))
        }
        const gh = new DefaultGhClient(runner)
        await gh.issueClose({repo: 'acme/widgets', number: 42})
        expect(captured.slice(0, 3)).toEqual(['issue', 'close', '42'])
        expect(captured).toContain('--repo')
        expect(captured[captured.indexOf('--repo') + 1]).toBe('acme/widgets')
        expect(captured).not.toContain('--comment')
    })

    it('passes --comment when provided', async () => {
        let captured: readonly string[] = []
        const runner: GhRunner = (args) => {
            captured = args
            return Promise.resolve(result({}))
        }
        const gh = new DefaultGhClient(runner)
        await gh.issueClose({repo: 'acme/widgets', number: 42, comment: 'Closing as delivered'})
        expect(captured).toContain('--comment')
        expect(captured[captured.indexOf('--comment') + 1]).toBe('Closing as delivered')
    })

    it('throws on a non-zero exit (not silently swallowed)', async () => {
        const runner: GhRunner = () => Promise.resolve(result({code: 1, stderr: 'HTTP 401: Bad credentials'}))
        const gh = new DefaultGhClient(runner)
        await expect(gh.issueClose({repo: 'acme/widgets', number: 1})).rejects.toThrow(/401|failed/i)
    })
})

describe("prView always requests the schema's required fields (CP2 #15 — rollup subset crash)", () => {
    const fullPr = {
        number: 4,
        headRefName: 'staging',
        baseRefName: 'develop',
        state: 'OPEN',
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
    }

    it('unions number/headRefName/baseRefName/state into a subset request so the strict parse never starves', async () => {
        let captured: readonly string[] = []
        const runner: GhRunner = (args) => {
            captured = args
            return Promise.resolve(result({stdout: JSON.stringify(fullPr)}))
        }
        const gh = new DefaultGhClient(runner)
        // Caller asks for only state+mergeable (the rollup's real call shape, which
        // crashed parseGhJson before this fix because head/baseRefName were absent).
        const view = await gh.prView(4, ['state', 'mergeable'])
        expect(view.state).toBe('OPEN')
        const jsonIdx = captured.indexOf('--json')
        expect(jsonIdx).toBeGreaterThanOrEqual(0)
        const requested = captured[jsonIdx + 1]?.split(',') ?? []
        expect(requested).toEqual(
            expect.arrayContaining(['number', 'headRefName', 'baseRefName', 'state', 'mergeable'])
        )
    })

    it('does not duplicate a field the caller already requested', async () => {
        let captured: readonly string[] = []
        const runner: GhRunner = (args) => {
            captured = args
            return Promise.resolve(result({stdout: JSON.stringify(fullPr)}))
        }
        const gh = new DefaultGhClient(runner)
        await gh.prView(4, ['state', 'headRefName'])
        const jsonIdx = captured.indexOf('--json')
        const requested = captured[jsonIdx + 1]?.split(',') ?? []
        expect(requested.filter((f) => f === 'state')).toHaveLength(1)
        expect(requested.filter((f) => f === 'headRefName')).toHaveLength(1)
    })
})
