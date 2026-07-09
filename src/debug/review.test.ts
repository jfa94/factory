import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, dirname} from 'node:path'
import {PANEL_ROLES} from '../verifier/judgment/panel.js'
import {defaultConfig} from '../config/index.js'
import type {Config} from '../config/index.js'
import type {E2eProcResult, E2eRunOpts, PlaywrightTool} from '../verifier/e2e/index.js'
import type {Finding} from '../verifier/judgment/finding.js'
import {buildReviewManifest, adjudicateWholeScope, runCommittedE2e, foldE2eIntoBlockers} from './review.js'
import {at} from '../shared/index.js'

describe('buildReviewManifest', () => {
    it("bundles buildPanelManifest's request with the debug-specific diff-scope fields", async () => {
        const result = await buildReviewManifest({
            resumePhase: 'verify',
            base: 'origin/main',
            worktree: '/tmp/debug-worktree',
            crossVendor: {status: 'present', slot: {vendor: 'codex', model: 'gpt-5-codex'}},
        })

        expect(result.base).toBe('origin/main')
        expect(result.worktree).toBe('/tmp/debug-worktree')
        expect(result.codexAvailable).toBe(true)
        expect(result.codexAbsentReason).toBeUndefined()
        expect(result.manifest.cross_vendor?.status).toBe('present')
        expect(result.manifest.cross_vendor).toMatchObject({status: 'present', model: 'gpt-5-codex'})
        // 3b(ii): the composed codex prompt is a non-empty string carrying the diff-scope pointer.
        expect(
            result.manifest.cross_vendor?.status === 'present' ? result.manifest.cross_vendor.prompt : undefined
        ).toContain('git -C /tmp/debug-worktree diff origin/main')
        expect(result.manifest.resume_phase).toBe('verify')
        const roles = result.manifest.agents.map((a) => a.role).sort()
        expect(roles).toEqual([...PANEL_ROLES].sort())
        // Per-role reviewer model (Δ T reversal) — no maxTurns stamped (frontmatter governs).
        for (const agent of result.manifest.agents) {
            expect(agent.model).toBe(
                agent.role === 'quality-reviewer' || agent.role === 'systemic-failure-reviewer' ? 'opus' : 'sonnet'
            )
            expect(agent.max_turns).toBeUndefined()
        }
    })

    it('an absent resolution yields codexAvailable=false plus the exact reason (stamped on the manifest too)', async () => {
        const result = await buildReviewManifest({
            resumePhase: 'verify',
            base: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', // empty-tree SHA
            worktree: '/tmp/debug-worktree-2',
            crossVendor: {status: 'absent', reason: 'no cross-vendor model configured (codex.model)'},
        })
        expect(result.codexAvailable).toBe(false)
        expect(result.codexAbsentReason).toBe('no cross-vendor model configured (codex.model)')
        expect(result.manifest.cross_vendor).toEqual({
            status: 'absent',
            reason: 'no cross-vendor model configured (codex.model)',
        })
        expect(result.base).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
    })
})

describe('adjudicateWholeScope', () => {
    let worktree: string

    beforeEach(async () => {
        worktree = await mkdtemp(join(tmpdir(), 'factory-debug-review-'))
    })

    afterEach(async () => {
        await rm(worktree, {recursive: true, force: true})
    })

    async function writeWorktreeFile(relPath: string, contents: string): Promise<void> {
        const abs = join(worktree, relPath)
        await mkdir(dirname(abs), {recursive: true})
        await writeFile(abs, contents)
    }

    function approve(reviewer: string): unknown {
        return {reviewer, verdict: 'approve', findings: []}
    }

    function blockedWith(reviewer: string, file: string, line: number, quote: string): unknown {
        return {
            reviewer,
            verdict: 'blocked',
            findings: [
                {
                    reviewer,
                    severity: 'critical',
                    blocking: true,
                    file,
                    line,
                    quote,
                    claim: 'checkable issue',
                    description: 'issue',
                },
            ],
        }
    }

    it('a clean pass: every reviewer approves → clean: true, no confirmed blockers', async () => {
        const result = await adjudicateWholeScope({
            reviews: [approve('implementation-reviewer'), approve('quality-reviewer')],
            verifications: [],
            worktree,
        })

        expect(result.clean).toBe(true)
        expect(result.confirmedBlockers).toEqual([])
        expect(result.adjudicated).toHaveLength(2)
        expect(result.adjudicated.every((a) => a.rawVerdict === 'approve')).toBe(true)
    })

    it('a confirmed blocker: clean: false, and the blocker is present in confirmedBlockers', async () => {
        await writeWorktreeFile('src/x.ts', 'line1\nconst x = 1\nline3\n')

        const result = await adjudicateWholeScope({
            reviews: [
                approve('implementation-reviewer'),
                blockedWith('quality-reviewer', 'src/x.ts', 2, 'const x = 1'),
            ],
            verifications: [
                {
                    reviewer: 'quality-reviewer',
                    verdicts: [{file: 'src/x.ts', line: 2, holds: true, note: 'confirmed'}],
                },
            ],
            worktree,
        })

        expect(result.clean).toBe(false)
        expect(result.confirmedBlockers).toHaveLength(1)
        expect(result.confirmedBlockers[0]?.description).toBe('issue')
        const quality = result.adjudicated.find((a) => a.reviewer === 'quality-reviewer')
        expect(quality?.confirmedBlockers).toHaveLength(1)
        expect(quality?.hadVerifierError).toBe(false)
    })

    it('a refuted finding does NOT appear in confirmedBlockers', async () => {
        await writeWorktreeFile('src/y.ts', 'line1\nconst y = 1\nline3\n')

        const result = await adjudicateWholeScope({
            reviews: [blockedWith('quality-reviewer', 'src/y.ts', 2, 'const y = 1')],
            verifications: [
                {
                    reviewer: 'quality-reviewer',
                    verdicts: [{file: 'src/y.ts', line: 2, holds: false, note: 'does not hold'}],
                },
            ],
            worktree,
        })

        expect(result.clean).toBe(true)
        expect(result.confirmedBlockers).toEqual([])
        const quality = result.adjudicated.find((a) => a.reviewer === 'quality-reviewer')
        expect(quality?.confirmedBlockers).toEqual([])
        expect(quality?.hadVerifierError).toBe(false)
    })

    it('a verifier error throws LOUD naming the reviewer — never a silent pass', async () => {
        await writeWorktreeFile('src/z.ts', 'line1\nconst z = 1\nline3\n')

        // No pre-recorded verdict for this citation → the replay runner rejects,
        // which confirmBlocker turns into an `error` outcome (fail-closed) →
        // adjudicateWholeScope must throw rather than resolve `clean: true`,
        // since a verifier error means the pass's true clean/dirty status is
        // UNKNOWN, not "not clean".
        await expect(
            adjudicateWholeScope({
                reviews: [blockedWith('quality-reviewer', 'src/z.ts', 2, 'const z = 1')],
                verifications: [],
                worktree,
            })
        ).rejects.toThrow(/finding-verifier error.*quality-reviewer/)
    })

    it('an unparseable raw review throws (LOUD, never silently skipped)', async () => {
        await expect(
            adjudicateWholeScope({
                reviews: [{reviewer: 'quality-reviewer', verdict: 'not-a-real-verdict', findings: []}],
                verifications: [],
                worktree,
            })
        ).rejects.toThrow()
    })

    it('does not surface mergeGate or result on its return shape', async () => {
        const result = await adjudicateWholeScope({
            reviews: [approve('quality-reviewer')],
            verifications: [],
            worktree,
        })
        expect(result).not.toHaveProperty('mergeGate')
        expect(result).not.toHaveProperty('result')
    })
})

describe('runCommittedE2e', () => {
    /** e2e.startCommand/baseURL configured — mirrors `src/orchestrator/e2e.test.ts`'s `e2eConfig()`. */
    function configuredE2e(): Config['e2e'] {
        const base = defaultConfig()
        return {...base.e2e, startCommand: 'npm start', baseURL: 'http://localhost:3000'}
    }

    interface ScriptedSpec {
        readonly file: string
        readonly title: string
        readonly status: 'passed' | 'failed' | 'flaky' | 'skipped'
    }

    function pwStatus(s: ScriptedSpec['status']): 'expected' | 'unexpected' | 'flaky' | 'skipped' {
        if (s === 'passed') {
            return 'expected'
        }
        if (s === 'failed') {
            return 'unexpected'
        }
        return s
    }

    /** A `PlaywrightTool` fake reporting a caller-supplied plan — mirrors `runner.test.ts`'s `okTool`. */
    class ScriptedPlaywrightTool implements PlaywrightTool {
        readonly calls: E2eRunOpts[] = []
        constructor(
            private readonly specs: readonly ScriptedSpec[],
            private readonly code = 0,
            private readonly errors: readonly {message: string}[] = []
        ) {}
        run(opts: E2eRunOpts): Promise<E2eProcResult> {
            this.calls.push(opts)
            const report = {
                suites: [
                    {
                        specs: this.specs.map((s) => ({
                            title: s.title,
                            file: s.file,
                            tests: [{status: pwStatus(s.status)}],
                        })),
                    },
                ],
                ...(this.errors.length > 0 ? {errors: this.errors} : {}),
            }
            return Promise.resolve({code: this.code, stdout: JSON.stringify(report), stderr: '', truncated: false})
        }
    }

    it('configured + all-green: findings is empty', async () => {
        const tool = new ScriptedPlaywrightTool([
            {file: 'e2e/checkout.spec.ts', title: 'checkout works', status: 'passed'},
        ])
        const result = await runCommittedE2e({cwd: '/wt', config: configuredE2e()}, tool)
        expect(result.kind).toBe('ran')
        if (result.kind !== 'ran') {
            throw new Error('expected ran')
        }
        expect(result.results.ok).toBe(true)
        expect(result.findings).toEqual([])
    })

    it('configured + one failed spec: one blocking finding citing the spec file/title', async () => {
        const tool = new ScriptedPlaywrightTool([
            {file: 'e2e/checkout.spec.ts', title: 'checkout works', status: 'passed'},
            {file: 'e2e/login.spec.ts', title: 'login works', status: 'failed'},
        ])
        const result = await runCommittedE2e({cwd: '/wt', config: configuredE2e()}, tool)
        expect(result.kind).toBe('ran')
        if (result.kind !== 'ran') {
            throw new Error('expected ran')
        }
        expect(result.findings).toHaveLength(1)
        const finding = at(result.findings, 0)
        expect(finding).toMatchObject({
            reviewer: 'e2e',
            severity: 'critical',
            blocking: true,
            file: 'e2e/login.spec.ts',
            line: 1,
            quote: 'login works',
        })
        expect(finding.description).toContain('login works')
    })

    it('configured + flaky-only: no finding (advisory-only, never gates)', async () => {
        const tool = new ScriptedPlaywrightTool([
            {file: 'e2e/search.spec.ts', title: 'search is slow', status: 'flaky'},
        ])
        const result = await runCommittedE2e({cwd: '/wt', config: configuredE2e()}, tool)
        expect(result.kind).toBe('ran')
        if (result.kind !== 'ran') {
            throw new Error('expected ran')
        }
        expect(result.results.ok).toBe(true)
        expect(result.findings).toEqual([])
    })

    it('configured + skipped-only: no finding (advisory-only, never gates)', async () => {
        const tool = new ScriptedPlaywrightTool([{file: 'e2e/old.spec.ts', title: 'old flow', status: 'skipped'}])
        const result = await runCommittedE2e({cwd: '/wt', config: configuredE2e()}, tool)
        expect(result.kind).toBe('ran')
        if (result.kind !== 'ran') {
            throw new Error('expected ran')
        }
        expect(result.findings).toEqual([])
    })

    it('unconfigured (neither startCommand nor baseURL): skipped, does not throw, never invokes the tool', async () => {
        const tool = new ScriptedPlaywrightTool([])
        const result = await runCommittedE2e({cwd: '/wt', config: defaultConfig().e2e}, tool)
        expect(result.kind).toBe('skipped')
        if (result.kind !== 'skipped') {
            throw new Error('expected skipped')
        }
        expect(result.reason).toContain('e2e.startCommand')
        expect(result.reason).toContain('e2e.baseURL')
        expect(tool.calls).toHaveLength(0)
    })

    it('unconfigured (baseURL set, startCommand missing): still skipped — both are required', async () => {
        const cfg = {...defaultConfig().e2e, baseURL: 'http://localhost:3000'}
        const result = await runCommittedE2e({cwd: '/wt', config: cfg})
        expect(result.kind).toBe('skipped')
    })

    it('tooling failure (nonzero exit, zero individually-failed specs): one blocking, uncitable finding', async () => {
        const tool = new ScriptedPlaywrightTool(
            [{file: 'e2e/checkout.spec.ts', title: 'checkout works', status: 'passed'}],
            1,
            [{message: 'webServer failed to start'}]
        )
        const result = await runCommittedE2e({cwd: '/wt', config: configuredE2e()}, tool)
        expect(result.kind).toBe('ran')
        if (result.kind !== 'ran') {
            throw new Error('expected ran')
        }
        expect(result.results.ok).toBe(false)
        expect(result.results.counts.failed).toBe(0)
        expect(result.findings).toHaveLength(1)
        const finding = at(result.findings, 0)
        expect(finding.blocking).toBe(true)
        expect(finding.severity).toBe('critical')
        expect(finding.file).toBeUndefined()
        expect(finding.line).toBeUndefined()
        expect(finding.quote.length).toBeGreaterThan(0) // Finding.quote requires min(1)
    })

    it('tooling THROW (missing binary, truncated reporter output): one blocking, uncitable finding — never an uncaught crash', async () => {
        const tool: PlaywrightTool = {
            run(): Promise<E2eProcResult> {
                throw new Error('playwright: command not found')
            },
        }
        const result = await runCommittedE2e({cwd: '/wt', config: configuredE2e()}, tool)
        expect(result.kind).toBe('ran')
        if (result.kind !== 'ran') {
            throw new Error('expected ran')
        }
        expect(result.results.ok).toBe(false)
        expect(result.findings).toHaveLength(1)
        const finding = at(result.findings, 0)
        expect(finding.blocking).toBe(true)
        expect(finding.severity).toBe('critical')
        expect(finding.description).toContain('command not found')
        expect(finding.quote.length).toBeGreaterThan(0) // Finding.quote requires min(1)
    })

    it('passes the scrubbed FACTORY_E2E_* env + replaceEnv:true + testDir into the tool call', async () => {
        const tool = new ScriptedPlaywrightTool([
            {file: 'e2e/checkout.spec.ts', title: 'checkout works', status: 'passed'},
        ])
        await runCommittedE2e({cwd: '/wt', config: configuredE2e()}, tool)
        expect(tool.calls).toHaveLength(1)
        const call = at(tool.calls, 0)
        expect(call.cwd).toBe('/wt')
        expect(call.testDir).toBe('e2e')
        expect(call.replaceEnv).toBe(true)
        expect(call.env).toMatchObject({
            BASE_URL: 'http://localhost:3000',
            FACTORY_E2E_START_COMMAND: 'npm start',
            FACTORY_E2E_READY_TIMEOUT_MS: '30000',
            FACTORY_E2E: '1',
        })
    })
})

describe('foldE2eIntoBlockers', () => {
    const existing: Finding[] = [
        {
            reviewer: 'quality-reviewer',
            severity: 'critical',
            blocking: true,
            quote: 'const x = 1',
            claim: 'a magic number is hardcoded',
            description: 'issue',
        },
    ]

    it('returns confirmedBlockers unchanged when e2e was skipped', () => {
        const result = foldE2eIntoBlockers(existing, {kind: 'skipped', reason: 'not configured'})
        expect(result).toEqual(existing)
    })

    it('appends e2e findings onto confirmedBlockers when e2e ran', () => {
        const e2eFinding: Finding = {
            reviewer: 'e2e',
            severity: 'critical',
            blocking: true,
            file: 'e2e/login.spec.ts',
            line: 1,
            quote: 'login works',
            claim: 'e2e spec failed: login works',
            description: 'e2e spec failed: login works',
        }
        const result = foldE2eIntoBlockers(existing, {
            kind: 'ran',
            results: {ok: false, specs: [], counts: {passed: 0, failed: 1, flaky: 0, skipped: 0}},
            findings: [e2eFinding],
        })
        expect(result).toEqual([...existing, e2eFinding])
    })

    it('ran with zero e2e findings leaves confirmedBlockers unchanged (content-wise)', () => {
        const result = foldE2eIntoBlockers(existing, {
            kind: 'ran',
            results: {ok: true, specs: [], counts: {passed: 1, failed: 0, flaky: 0, skipped: 0}},
            findings: [],
        })
        expect(result).toEqual(existing)
    })
})
