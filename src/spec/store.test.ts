import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtemp, rm, readFile, mkdir, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SpecStore, makeSpecId} from './store.js'
import {specDir} from '../core/state/paths.js'
import {parseSpecManifest, type SpecManifest, type SpecTask} from './schema.js'
import {SpecPointerSchema} from '../types/index.js'
import type {Prd} from './gh.js'
import {at, nonNull} from '../shared/index.js'

/** The durable PRD snapshot every S9 write persists beside spec.md. */
const PRD: Prd = {
    issue_number: 123,
    title: 'Checkout Redesign',
    body: '## Requirements\n\n- checkout must work\n\n## Acceptance Criteria\n\n- returns 201',
    labels: ['prd'],
    body_truncated: false,
}

let dataDir: string
// A throwaway docs root so the F-specloc in-repo reviewable copy never lands in
// the real repo's docs/ during tests (test isolation — no shared mutable state).
let docsRoot: string

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ws5-store-'))
    docsRoot = await mkdtemp(join(tmpdir(), 'ws5-store-docs-'))
})
afterEach(async () => {
    await rm(dataDir, {recursive: true, force: true})
    await rm(docsRoot, {recursive: true, force: true})
})

/** Construct a store with both the dataDir and a throwaway docs root injected. */
function newStore(): SpecStore {
    return new SpecStore({dataDir, docsRoot})
}

function request(over: Partial<SpecManifest> = {}): SpecManifest {
    return parseSpecManifest({
        spec_id: '123-checkout',
        issue_number: 123,
        slug: 'checkout',
        repo: 'owner/name',
        generated_at: '2026-06-04T00:00:00.000Z',
        tasks: [
            {
                task_id: 'task_1',
                title: 'Add checkout',
                description: 'checkout flow',
                files: ['src/checkout.ts'],
                acceptance_criteria: ['returns 201'],
                tests_to_write: ['returns 201'],
                depends_on: [],
                risk_tier: 'medium',
                risk_rationale: 'payment',
            },
        ],
        ...over,
    })
}

describe('makeSpecId — issue is the stable key, slug via shared slugify', () => {
    it("spec-id construction: makeSpecId(123,'Checkout Redesign') === '123-checkout-redesign'", () => {
        expect(makeSpecId(123, 'Checkout Redesign')).toBe('123-checkout-redesign')
    })
    it('rejects a non-positive issue', () => {
        expect(() => makeSpecId(0, 'x')).toThrow()
    })
    it('rejects a slug with no usable characters', () => {
        expect(() => makeSpecId(1, '!!!')).toThrow()
    })
})

describe('SpecStore.write — durable bare-array tasks.json + pointer', () => {
    it('writes spec.md + a BARE tasks.json array and returns a SpecPointer', async () => {
        const store = newStore()
        const m = request()
        const pointer = await store.write(m, '# Checkout spec', PRD)

        const dir = specDir(dataDir, m.repo, m.spec_id)
        expect(await readFile(join(dir, 'spec.md'), 'utf8')).toBe('# Checkout spec')

        const tasksRaw = JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8')) as SpecTask[]
        expect(Array.isArray(tasksRaw)).toBe(true) // BARE array, not {tasks:[...]}
        expect(at(tasksRaw, 0).task_id).toBe('task_1')

        expect(SpecPointerSchema.parse(pointer)).toEqual({
            repo: 'owner/name',
            spec_id: '123-checkout',
            issue_number: 123,
        })
    })
})

describe('SpecStore.write — F-specloc: in-repo reviewable copy under docs/factory/<spec-id>/', () => {
    it('ALSO writes spec.md + tasks.json to <docsRoot>/factory/<spec-id>/ (PR-reviewable)', async () => {
        const docsRoot = await mkdtemp(join(tmpdir(), 'ws5-docs-'))
        try {
            const store = new SpecStore({dataDir, docsRoot})
            const m = request()
            await store.write(m, '# Checkout spec', PRD)

            const reviewDir = join(docsRoot, 'factory', m.spec_id)
            expect(await readFile(join(reviewDir, 'spec.md'), 'utf8')).toBe('# Checkout spec')
            const reviewTasks = JSON.parse(await readFile(join(reviewDir, 'tasks.json'), 'utf8')) as SpecTask[]
            expect(Array.isArray(reviewTasks)).toBe(true)
            expect(at(reviewTasks, 0).task_id).toBe('task_1')
        } finally {
            await rm(docsRoot, {recursive: true, force: true})
        }
    })

    it('keeps the CANONICAL read-path in the dataDir — read() never touches docsRoot', async () => {
        const docsRoot = await mkdtemp(join(tmpdir(), 'ws5-docs-'))
        try {
            const store = new SpecStore({dataDir, docsRoot})
            const m = request()
            await store.write(m, '# spec', PRD)
            // Blow away the in-repo copy: the canonical read still resolves from dataDir.
            await rm(join(docsRoot, 'factory'), {recursive: true, force: true})
            const read = await store.read(m.repo, m.spec_id)
            expect(at(read.tasks, 0).task_id).toBe('task_1')
            // And rerun-by-issue still resolves from the dataDir scan (not docsRoot).
            const found = await store.resolveByIssue(m.repo, m.issue_number)
            expect(nonNull(found).spec_id).toBe(m.spec_id)
        } finally {
            await rm(docsRoot, {recursive: true, force: true})
        }
    })

    it('mirror-write failure does NOT abort the canonical store (best-effort-but-loud)', async () => {
        // Force the in-repo mirror write to fail deterministically: point docsRoot at
        // an existing FILE. docsFactoryDir() resolves to <docsRoot>/factory/<spec-id>,
        // so atomicWriteFile's `mkdir(..., {recursive:true})` hits an existing file as
        // an ancestor and throws ENOTDIR — cross-platform-safe, no perms juggling.
        const docsFile = join(await mkdtemp(join(tmpdir(), 'ws5-docsfile-')), 'docs')
        await writeFile(docsFile, 'i am a file, not a dir')

        const store = new SpecStore({dataDir, docsRoot: docsFile})
        const m = request()

        // write() must RESOLVE — the mirror failure is swallowed-but-warned, not fatal.
        const pointer = await store.write(m, '# Checkout spec', PRD)
        expect(SpecPointerSchema.parse(pointer)).toEqual({
            repo: 'owner/name',
            spec_id: '123-checkout',
            issue_number: 123,
        })

        // The CANONICAL spec is fully + correctly persisted in the dataDir.
        const dir = specDir(dataDir, m.repo, m.spec_id)
        expect(await readFile(join(dir, 'spec.md'), 'utf8')).toBe('# Checkout spec')
        const tasksRaw = JSON.parse(await readFile(join(dir, 'tasks.json'), 'utf8')) as SpecTask[]
        expect(Array.isArray(tasksRaw)).toBe(true)
        expect(at(tasksRaw, 0).task_id).toBe('task_1')
        expect(await readFile(join(dir, 'spec.meta.json'), 'utf8')).toContain('generated_at')

        // read / resolveByIssue still resolve from the canonical dataDir store.
        const read = await store.read(m.repo, m.spec_id)
        expect(at(read.tasks, 0).task_id).toBe('task_1')
        const found = await store.resolveByIssue(m.repo, m.issue_number)
        expect(nonNull(found).spec_id).toBe(m.spec_id)

        // And the in-repo copy is ABSENT (the mirror never landed).
        await expect(readFile(join(docsFile, 'factory', m.spec_id, 'spec.md'), 'utf8')).rejects.toThrow()
    })

    it('does NOT leak run/spec internals into docs/: no spec.meta.json holdout in the copy', async () => {
        const docsRoot = await mkdtemp(join(tmpdir(), 'ws5-docs-'))
        try {
            const store = new SpecStore({dataDir, docsRoot})
            const m = request()
            await store.write(m, '# spec', PRD)
            const reviewDir = join(docsRoot, 'factory', m.spec_id)
            // Sidecar is a dataDir reconstruction detail — keep it out of the repo copy.
            await expect(readFile(join(reviewDir, 'spec.meta.json'), 'utf8')).rejects.toThrow()
            // The dataDir copy DOES carry the holdout (canonical reconstruction).
            const canonicalDir = specDir(dataDir, m.repo, m.spec_id)
            expect(await readFile(join(canonicalDir, 'spec.meta.json'), 'utf8')).toContain('generated_at')
        } finally {
            await rm(docsRoot, {recursive: true, force: true})
        }
    })
})

describe('SpecStore PRD snapshot (S9, Decision 47)', () => {
    it('write persists prd.json beside spec.md — canonical only, NOT mirrored to docs/', async () => {
        const store = newStore()
        const m = request()
        await store.write(m, '# spec', PRD)

        const dir = specDir(dataDir, m.repo, m.spec_id)
        const persisted = JSON.parse(await readFile(join(dir, 'prd.json'), 'utf8')) as Prd
        expect(persisted).toEqual(PRD)
        // The PRD is already public on the issue — no in-repo mirror copy.
        await expect(readFile(join(docsRoot, 'factory', m.spec_id, 'prd.json'), 'utf8')).rejects.toThrow()
    })

    it('hasPrd: false before write, true after; readPrd round-trips', async () => {
        const store = newStore()
        const m = request()
        expect(await store.hasPrd(m.repo, m.spec_id)).toBe(false)
        await store.write(m, '# spec', PRD)
        expect(await store.hasPrd(m.repo, m.spec_id)).toBe(true)
        expect(await store.readPrd(m.repo, m.spec_id)).toEqual(PRD)
    })

    it('readPrd fails loud with the backfill remedy on a pre-S9 spec (no snapshot)', async () => {
        const store = newStore()
        const m = request()
        await store.write(m, '# spec', PRD)
        await rm(join(specDir(dataDir, m.repo, m.spec_id), 'prd.json')) // fabricate a pre-S9 dir
        await expect(store.readPrd(m.repo, m.spec_id)).rejects.toThrow(
            /predates the S9 PRD snapshot.*factory spec resolve --issue 123/s
        )
    })

    it('writePrd backfills a spec dir that lacks the snapshot', async () => {
        const store = newStore()
        const m = request()
        await store.write(m, '# spec', PRD)
        await rm(join(specDir(dataDir, m.repo, m.spec_id), 'prd.json'))
        await store.writePrd(m.repo, m.spec_id, PRD)
        expect(await store.readPrd(m.repo, m.spec_id)).toEqual(PRD)
    })
})

describe('SpecStore.resolveByIssue — Δ X reuse-by-issue-number', () => {
    it('Δ X: returns an existing request for a known issue number', async () => {
        const store = newStore()
        await store.write(request(), '# spec', PRD)

        const found = await store.resolveByIssue('owner/name', 123)
        expect(found).not.toBeNull()
        expect(nonNull(found).spec_id).toBe('123-checkout')
        expect(at(nonNull(found).tasks, 0).task_id).toBe('task_1')
    })

    it('Δ X: looks up by ISSUE NUMBER even when the slug would differ', async () => {
        const store = newStore()
        // Stored slug is "checkout"; a rerun would never re-derive it — issue is the key.
        await store.write(request({spec_id: '123-checkout', slug: 'checkout'}), '# spec', PRD)
        const found = await store.resolveByIssue('owner/name', 123)
        expect(nonNull(found).spec_id).toBe('123-checkout')
    })

    it('returns null when no spec exists for the issue', async () => {
        const store = newStore()
        expect(await store.resolveByIssue('owner/name', 999)).toBeNull()
    })

    it('returns null when the repo dir does not exist', async () => {
        const store = newStore()
        expect(await store.resolveByIssue('nobody/nothing', 1)).toBeNull()
    })

    it('does not confuse issue 12 with issue 123 (exact issue match)', async () => {
        const store = newStore()
        await store.write(request({spec_id: '123-checkout', issue_number: 123}), '# spec', PRD)
        expect(await store.resolveByIssue('owner/name', 12)).toBeNull()
    })

    it('throws loudly on two dirs for the same issue (store-integrity defect)', async () => {
        const store = newStore()
        await store.write(request({spec_id: '123-checkout'}), '# spec', PRD)
        await store.write(request({spec_id: '123-checkout-v2', slug: 'checkout-v2'}), '# spec', PRD)
        await expect(store.resolveByIssue('owner/name', 123)).rejects.toThrow(/multiple specs/)
    })

    it('rejects a non-positive issue number', async () => {
        const store = newStore()
        await expect(store.resolveByIssue('owner/name', 0)).rejects.toThrow()
    })
})

describe('SpecStore.read — round-trips through the durable store', () => {
    it('reconstructs the request from the on-disk bare array + holdout', async () => {
        const store = newStore()
        const m = request()
        await store.write(m, '# spec', PRD)
        const read = await store.read('owner/name', '123-checkout')
        expect(read.issue_number).toBe(123)
        expect(read.slug).toBe('checkout')
        expect(read.generated_at).toBe('2026-06-04T00:00:00.000Z')
        expect(read.tasks).toEqual(m.tasks)
    })

    it('fails loud on a corrupt durable spec rather than treating it as a miss', async () => {
        const store = newStore()
        const dir = specDir(dataDir, 'owner/name', '123-broken')
        await mkdir(dir, {recursive: true})
        // Write an invalid tasks.json (legacy risk value) + a holdout.
        await writeFile(join(dir, 'tasks.json'), JSON.stringify([{task_id: 'x', risk_tier: 'security'}]))
        await writeFile(
            join(dir, 'spec.meta.json'),
            JSON.stringify({issue_number: 123, slug: 'broken', repo: 'owner/name', generated_at: 't'})
        )
        await expect(store.resolveByIssue('owner/name', 123)).rejects.toThrow()
    })
})

describe('SpecStore.deleteByIssue — supersede spec deletion', () => {
    it('deletes the canonical spec dir and returns true when a spec exists', async () => {
        const store = newStore()
        await store.write(request(), '# spec', PRD)

        const deleted = await store.deleteByIssue('owner/name', 123)
        expect(deleted).toBe(true)
        // resolveByIssue must return null after deletion (the dir is gone)
        expect(await store.resolveByIssue('owner/name', 123)).toBeNull()
    })

    it('returns false (no-op) when no spec exists for the issue', async () => {
        const store = newStore()
        expect(await store.deleteByIssue('owner/name', 999)).toBe(false)
    })

    it('returns false (no-op) when the repo dir does not exist', async () => {
        const store = newStore()
        expect(await store.deleteByIssue('nobody/nothing', 1)).toBe(false)
    })

    it('is idempotent — a second call returns false and does not throw', async () => {
        const store = newStore()
        await store.write(request(), '# spec', PRD)
        await store.deleteByIssue('owner/name', 123)
        expect(await store.deleteByIssue('owner/name', 123)).toBe(false)
    })

    it('rejects a non-positive issue number', async () => {
        const store = newStore()
        await expect(store.deleteByIssue('owner/name', 0)).rejects.toThrow()
    })
})
