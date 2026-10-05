import {describe, expect, it} from 'vitest'
import {z} from 'zod'
import {DefaultGhClient, parseGhJson} from './gh-client.js'
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

    it('repoProtection reads strict + contexts and the merge-queue rule on a 200', async () => {
        const runner: GhRunner = (args) => {
            if (args.includes('repos/o/r/rules/branches/develop')) {
                return Promise.resolve(result({stdout: JSON.stringify([{type: 'merge_queue'}])}))
            }
            return Promise.resolve(
                result({stdout: JSON.stringify({required_status_checks: {strict: true, contexts: ['Quality']}})})
            )
        }
        await expect(new DefaultGhClient(runner).repoProtection('o', 'r', 'develop')).resolves.toEqual({
            enabled: true,
            requiredStatusChecks: ['Quality'],
            strictUpToDate: true,
            hasMergeQueue: true,
        })
    })

    it('repoProtection contains a merge-queue probe failure as no queue', async () => {
        const runner: GhRunner = (args) =>
            Promise.resolve(
                args.some((a) => a.includes('/rules/'))
                    ? result({code: 1, stderr: 'HTTP 503: Service Unavailable'})
                    : result({stdout: JSON.stringify({required_status_checks: null})})
            )
        await expect(new DefaultGhClient(runner).repoProtection('o', 'r', 'develop')).resolves.toEqual({
            enabled: true,
            requiredStatusChecks: [],
            strictUpToDate: false,
            hasMergeQueue: false,
        })
    })

    it('repoProtection throws on a truncated 200 body', async () => {
        const runner: GhRunner = () => Promise.resolve(result({stdout: '{"required_', truncated: true}))
        await expect(new DefaultGhClient(runner).repoProtection('o', 'r', 'develop')).rejects.toThrow(/truncated/i)
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

describe('putProtection (the --provision PUT body)', () => {
    it('strengthens only status checks while preserving existing app bindings', async () => {
        const calls: {args: readonly string[]; input: string | Uint8Array | undefined}[] = []
        const runner: GhRunner = (args, opts) => {
            calls.push({args, input: opts?.input})
            return Promise.resolve(result({stdout: JSON.stringify({checks: [{context: 'Team CI', app_id: 42}]})}))
        }
        await new DefaultGhClient(runner).strengthenStatusChecks('acme', 'widgets', 'develop', ['Team CI', 'Quality'])
        expect(calls.map((call) => call.args)).toEqual([
            ['api', 'repos/acme/widgets/branches/develop/protection/required_status_checks'],
            [
                'api',
                '--method',
                'PATCH',
                'repos/acme/widgets/branches/develop/protection/required_status_checks',
                '--input',
                '-',
            ],
        ])
        expect(JSON.parse(String(calls[1]?.input))).toEqual({
            strict: true,
            checks: [
                {context: 'Team CI', app_id: 42},
                {context: 'Quality', app_id: -1},
            ],
        })
    })
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
