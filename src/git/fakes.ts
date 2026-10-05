/**
 * In-memory fakes implementing GitClient / GhClient for tests.
 *
 * These satisfy "mock seams via exported types/constructors, not by stubbing exec
 * or editing seam files". They model a remote-URL table and per-branch protection
 * state so repo auto-derivation and the protection probe/provision paths are
 * SCRIPTABLE with zero real git/gh invocation.
 *
 * Interface-parity note: these fakes have sync bodies but must satisfy the
 * Promise-returning GitClient/GhClient signatures. Non-throwing methods drop
 * `async` and `return Promise.resolve(x)`; methods that model a failure return
 * `Promise.reject(err)` (NOT a synchronous `throw`) so `.catch()`/`.rejects`
 * consumers observe a real rejection, exactly as with the real async clients.
 */
import type {GitClient, GitOpts} from './git-client.js'
import type {GhClient, GhOpts, ProtectionApiResult, ProtectionPutBody} from './gh-client.js'

// ---------------------------------------------------------------------------
// FakeGitClient
// ---------------------------------------------------------------------------

/** In-memory GitClient. Records every call so tests can assert ordering. */
export class FakeGitClient implements GitClient {
    /** remote name → configured remote URL (for `remoteUrl` / `--repo` auto-derive). */
    readonly remoteUrls = new Map<string, string>()
    /** When true, `remoteUrl` reports a miss (simulate a non-git dir / no remote). */
    failRemoteUrl = false
    /** Ordered log of git ops, for assertions. */
    readonly calls: string[] = []

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
}

// ---------------------------------------------------------------------------
// FakeGhClient
// ---------------------------------------------------------------------------

/** Construction options for {@link FakeGhClient}. */
export interface FakeGhOptions {
    /** Seed branch protection per branch. */
    protection?: Record<string, ProtectionApiResult>
}

/** In-memory GhClient over a per-branch protection table. Records calls for assertions. */
export class FakeGhClient implements GhClient {
    /** branch → protection state. */
    readonly protection = new Map<string, ProtectionApiResult>()
    /** Ordered log of gh ops, for assertions. */
    readonly calls: string[] = []
    /** Ordered log of putProtection bodies — assert exact profiles (strict/contexts/enforceAdmins). */
    readonly protectionPuts: {branch: string; body: ProtectionPutBody}[] = []
    /** When set, putProtection for THIS branch rejects (simulated 401/403/5xx). */
    failPutProtectionFor?: string
    /** When set, mergeQueueProbe rejects with this (the probe's "couldn't tell" throw). */
    failMergeQueueProbe?: Error

    constructor(opts: FakeGhOptions = {}) {
        for (const [b, p] of Object.entries(opts.protection ?? {})) {
            this.protection.set(b, p)
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
}
