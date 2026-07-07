import {describe, it, expect} from 'vitest'
import {
    buildPartialReport,
    renderPartialReportMarkdown,
    renderFailureComment,
    selfHealCommentMarker,
    failureCommentMarker,
} from './partial-report.js'
import {parseRunState, type RunState, type TaskState} from '../types/index.js'
import {parseSpecManifest, type SpecManifest, type SpecTask} from '../spec/schema.js'

// ---------------------------------------------------------------------------
// Builders — minimal valid RunState / SpecManifest fixtures.
// ---------------------------------------------------------------------------

function specTask(id: string, overrides: Partial<SpecTask> = {}): SpecTask {
    return {
        task_id: id,
        title: `Title ${id}`,
        description: `Does ${id}`,
        files: [`src/${id}.ts`],
        acceptance_criteria: [`${id} criterion one`, `${id} criterion two`],
        tests_to_write: [`${id}.test.ts: asserts one`, `${id}.test.ts: asserts two`],
        depends_on: [],
        risk_tier: 'medium',
        risk_rationale: 'contained blast radius',
        ...overrides,
    }
}

function makeSpec(tasks: SpecTask[]): SpecManifest {
    return parseSpecManifest({
        spec_id: '42-checkout',
        issue_number: 42,
        slug: 'checkout',
        repo: 'acme/widgets',
        generated_at: '2026-01-01T00:00:00.000Z',
        tasks,
    })
}

function doneTask(id: string, pr: number): TaskState {
    return {
        task_id: id,
        status: 'done',
        branch: `factory/run-1/${id}`,
        pr_number: pr,
    } as TaskState
}

function failedTask(id: string, failure_class: TaskState['failure_class'], reason: string): TaskState {
    return {
        task_id: id,
        status: 'failed',
        failure_class,
        failure_reason: reason,
    } as TaskState
}

function pendingTask(id: string, status: TaskState['status'] = 'pending'): TaskState {
    const phase = status === 'executing' ? {phase: 'exec'} : {}
    return {task_id: id, status, ...phase} as TaskState
}

function makeRun(tasks: TaskState[], overrides: Partial<RunState> = {}): RunState {
    const record: Record<string, TaskState> = {}
    for (const t of tasks) {
        record[t.task_id] = t
    }
    return parseRunState({
        schema_version: 3,
        run_id: 'run-1',
        staging_branch: 'staging-run-1',
        status: 'failed',
        execution_mode: 'balanced',
        spec: {repo: 'acme/widgets', spec_id: '42-checkout', issue_number: 42},
        tasks: record,
        started_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T01:00:00.000Z',
        ended_at: '2026-01-01T01:00:00.000Z',
        ...overrides,
    })
}

const NOW = '2026-02-02T12:00:00.000Z'

// ---------------------------------------------------------------------------

describe('buildPartialReport', () => {
    it('classifies a partial run into shipped + failures with derived unmet criteria', () => {
        const spec = makeSpec([specTask('t1'), specTask('t2'), specTask('t3')])
        const run = makeRun([
            doneTask('t1', 11),
            doneTask('t2', 12),
            failedTask('t3', 'capability-budget', 'ladder exhausted'),
        ])

        const report = buildPartialReport(run, spec, {now: NOW})

        expect(report.run_status).toBe('failed')
        expect(report.totals).toEqual({total: 3, shipped: 2, failed: 1, incomplete: 0})
        expect(report.generated_at).toBe(NOW)
        expect(report.spec_id).toBe('42-checkout')
        expect(report.issue_number).toBe(42)

        expect(report.shipped.map((s) => s.task_id)).toEqual(['t1', 't2'])
        expect(report.shipped[0]).toMatchObject({title: 'Title t1', pr_number: 11})

        expect(report.failures).toHaveLength(1)
        expect(report.failures[0]).toMatchObject({
            task_id: 't3',
            failure_class: 'capability-budget',
            failure_reason: 'ladder exhausted',
            unmet_criteria: ['t3 criterion one', 't3 criterion two'],
        })
    })

    it('orders output by spec position, not by run.tasks insertion order', () => {
        const spec = makeSpec([specTask('a'), specTask('b'), specTask('c')])
        // Insert in reverse order.
        const run = makeRun([doneTask('c', 3), doneTask('b', 2), doneTask('a', 1)], {
            status: 'completed',
        })

        const report = buildPartialReport(run, spec, {now: NOW})
        expect(report.shipped.map((s) => s.task_id)).toEqual(['a', 'b', 'c'])
    })

    it('a completed run has no failures or incompletes', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {status: 'completed'})

        const report = buildPartialReport(run, spec, {now: NOW})
        expect(report.totals).toEqual({total: 1, shipped: 1, failed: 0, incomplete: 0})
        expect(report.failures).toEqual([])
        expect(report.incomplete).toEqual([])
    })

    it('a failed run (nothing shipped) lists all fails, no shipped', () => {
        const spec = makeSpec([specTask('t1'), specTask('t2')])
        const run = makeRun(
            [
                failedTask('t1', 'spec-defect', 'untestable criterion'),
                failedTask('t2', 'blocked-environmental', 'dependency failed'),
            ],
            {status: 'failed'}
        )

        const report = buildPartialReport(run, spec, {now: NOW})
        expect(report.shipped).toEqual([])
        expect(report.totals).toEqual({total: 2, shipped: 0, failed: 2, incomplete: 0})
        expect(report.failures.map((f) => f.failure_class)).toEqual(['spec-defect', 'blocked-environmental'])
    })

    it('lists non-terminal tasks as incomplete (suspended run)', () => {
        const spec = makeSpec([specTask('t1'), specTask('t2'), specTask('t3')])
        const run = makeRun([doneTask('t1', 1), pendingTask('t2', 'executing'), pendingTask('t3', 'pending')], {
            status: 'suspended',
            ended_at: null,
        })

        const report = buildPartialReport(run, spec, {now: NOW})
        expect(report.totals).toEqual({total: 3, shipped: 1, failed: 0, incomplete: 2})
        expect(report.incomplete.map((i) => `${i.task_id}:${i.status}`)).toEqual(['t2:executing', 't3:pending'])
    })

    it('throws loud when a run task is absent from the spec (run/spec mismatch)', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1), doneTask('ghost', 2)], {status: 'completed'})

        expect(() => buildPartialReport(run, spec, {now: NOW})).toThrow(/ghost.*absent from spec/)
    })

    it('carries branch/pr pointers through to failures when present', () => {
        const spec = makeSpec([specTask('t1')])
        const failed: TaskState = {
            ...failedTask('t1', 'capability-budget', 'exhausted'),
            branch: 'factory/run-1/t1',
            pr_number: 99,
        }
        const run = makeRun([failed], {status: 'failed'})

        const report = buildPartialReport(run, spec, {now: NOW})
        expect(report.failures[0]).toMatchObject({branch: 'factory/run-1/t1', pr_number: 99})
    })

    it('surfaces e2e_failure when every task shipped but the e2e phase failed (Decision 39)', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {
            status: 'failed',
            e2e_phase: {
                status: 'failed',
                reason: 'checkout: cap-exhausted critical',
                manifest: [],
                reopen_counts: {},
                ended_at: NOW,
            },
        })

        const report = buildPartialReport(run, spec, {now: NOW})
        expect(report.failures).toEqual([])
        expect(report.e2e_failure).toBe('checkout: cap-exhausted critical')
    })

    it('omits e2e_failure when the e2e phase is absent or done', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {status: 'completed'})

        expect(buildPartialReport(run, spec, {now: NOW}).e2e_failure).toBeUndefined()
    })

    it('surfaces traceability_failure + non-met gaps when the PRD audit condemned the run (S9, Decision 47)', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {
            status: 'failed',
            traceability: {
                status: 'failed',
                reason: 'PRD requirements unmet: "returns 201"',
                verdicts: [
                    {requirement: 'checkout must work', verdict: 'met', evidence: 'checkout.ts:1'},
                    {requirement: 'returns 201', verdict: 'unmet', evidence: 'no 201 in the diff'},
                ],
                ended_at: NOW,
            },
        })

        const report = buildPartialReport(run, spec, {now: NOW})
        expect(report.failures).toEqual([])
        expect(report.traceability_failure).toBe('PRD requirements unmet: "returns 201"')
        // Gaps carry ONLY the non-met rows — met rows are noise in a failure surface.
        expect(report.traceability_gaps).toEqual([
            {requirement: 'returns 201', verdict: 'unmet', evidence: 'no 201 in the diff'},
        ])
    })

    it('surfaces traceability_gaps for partial rows even on a DONE audit; omits both when clean or absent', () => {
        const spec = makeSpec([specTask('t1')])
        const partialDone = makeRun([doneTask('t1', 1)], {
            status: 'completed',
            traceability: {
                status: 'done',
                verdicts: [
                    {requirement: 'checkout must work', verdict: 'met', evidence: 'checkout.ts:1'},
                    {requirement: 'returns 201', verdict: 'partial', evidence: 'happy path only'},
                ],
                ended_at: NOW,
            },
        })
        const partialReport = buildPartialReport(partialDone, spec, {now: NOW})
        expect(partialReport.traceability_failure).toBeUndefined()
        expect(partialReport.traceability_gaps).toEqual([
            {requirement: 'returns 201', verdict: 'partial', evidence: 'happy path only'},
        ])

        const allMet = makeRun([doneTask('t1', 1)], {
            status: 'completed',
            traceability: {
                status: 'done',
                verdicts: [{requirement: 'checkout must work', verdict: 'met', evidence: 'ok'}],
                ended_at: NOW,
            },
        })
        expect(buildPartialReport(allMet, spec, {now: NOW}).traceability_gaps).toBeUndefined()

        const absent = makeRun([doneTask('t1', 1)], {status: 'completed'})
        const absentReport = buildPartialReport(absent, spec, {now: NOW})
        expect(absentReport.traceability_failure).toBeUndefined()
        expect(absentReport.traceability_gaps).toBeUndefined()
    })
})

describe('renderPartialReportMarkdown', () => {
    it('renders status, totals, shipped + failed sections with criteria', () => {
        const spec = makeSpec([specTask('t1'), specTask('t2')])
        const run = makeRun([doneTask('t1', 11), failedTask('t2', 'capability-budget', 'ladder exhausted')])

        const md = renderPartialReportMarkdown(buildPartialReport(run, spec, {now: NOW}))

        expect(md).toContain('# Factory run report — `run-1`')
        expect(md).toContain('**Status:** FAILED')
        expect(md).toContain('PRD #42')
        expect(md).toContain('2 total · 1 shipped · 1 failed · 0 incomplete')
        expect(md).toContain('## Shipped (1)')
        expect(md).toContain('- `t1` — Title t1 — PR #11 (`factory/run-1/t1`)')
        expect(md).toContain('## Failed (1)')
        expect(md).toContain('### `t2` — Title t2')
        expect(md).toContain('- **Class:** `capability-budget`')
        expect(md).toContain('  - t2 criterion one')
    })

    it('omits the Failed and Incomplete sections for a completed run', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {status: 'completed'})
        const md = renderPartialReportMarkdown(buildPartialReport(run, spec, {now: NOW}))

        expect(md).toContain('## Shipped (1)')
        expect(md).not.toContain('## Failed')
        expect(md).not.toContain('## Incomplete')
    })

    it('renders the Gates in force section (enforced + not-contracted + warnings)', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {status: 'completed'})
        const gates = {
            contracted: ['test', 'type'] as const,
            skipped: [{id: 'coverage', reason: 'not wired yet'}] as const,
            warnings: ["default-set gate 'tdd' is not contracted: dropped — the merge gate will not enforce it"],
        }
        const md = renderPartialReportMarkdown(buildPartialReport(run, spec, {now: NOW, gates}))

        expect(md).toContain('## Gates in force')
        expect(md).toContain('Enforced: `test`, `type`')
        expect(md).toContain('- `coverage` — not wired yet')
        expect(md).toContain("⚠️ default-set gate 'tdd' is not contracted")
    })

    it('renders the gates section loudly when the contract was unavailable at finalize', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {status: 'completed'})
        const md = renderPartialReportMarkdown(
            buildPartialReport(run, spec, {now: NOW, gatesUnavailable: 'contract absent at /repo'})
        )

        expect(md).toContain('## Gates in force')
        expect(md).toContain('⚠️ gate contract unavailable at finalize: contract absent at /repo')
    })

    it('shows _none_ when nothing shipped', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([failedTask('t1', 'spec-defect', 'untestable')], {status: 'failed'})
        const md = renderPartialReportMarkdown(buildPartialReport(run, spec, {now: NOW}))

        expect(md).toContain('## Shipped (0)')
        expect(md).toContain('_none_')
    })

    it('renders the e2e veto section even when nothing is in `failures` (Decision 39)', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {
            status: 'failed',
            e2e_phase: {
                status: 'failed',
                reason: 'checkout: cap-exhausted critical',
                manifest: [],
                reopen_counts: {},
                ended_at: NOW,
            },
        })
        const md = renderPartialReportMarkdown(buildPartialReport(run, spec, {now: NOW}))

        expect(md).toContain('## End-to-end verification failed')
        expect(md).toContain('checkout: cap-exhausted critical')
        expect(md).not.toContain('## Failed')
    })

    it('renders the PRD traceability sections — veto reason + gap rows (S9, Decision 47)', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {
            status: 'failed',
            traceability: {
                status: 'failed',
                reason: 'PRD requirements unmet: "returns 201"',
                verdicts: [
                    {requirement: 'checkout must work', verdict: 'met', evidence: 'checkout.ts:1'},
                    {requirement: 'returns 201', verdict: 'unmet', evidence: 'no 201 in the diff'},
                ],
                ended_at: NOW,
            },
        })
        const md = renderPartialReportMarkdown(buildPartialReport(run, spec, {now: NOW}))

        expect(md).toContain('## PRD traceability failed')
        expect(md).toContain('PRD requirements unmet: "returns 201"')
        expect(md).toContain('## PRD requirement gaps')
        expect(md).toContain('- **returns 201** (`unmet`): no 201 in the diff')
        expect(md).not.toContain('## Failed')
    })
})

describe('plain-language e2e narrative (Decision 40 D12)', () => {
    const E2E_RUN = {
        status: 'completed' as const,
        e2e_phase: {
            status: 'done' as const,
            manifest: [
                {
                    task_ids: ['t1'],
                    spec_path: 'e2e/checkout.spec.ts',
                    kind: 'critical' as const,
                    title: 'Buy an item and reach order confirmation',
                },
                // Pre-D12 manifest row without a title — spec_path fallback.
                {task_ids: ['t1'], spec_path: 'e2e/nav.spec.ts', kind: 'throwaway' as const},
            ],
            reopen_counts: {t1: 1, t2: 0},
            ended_at: NOW,
        },
        e2e_assessment: {
            status: 'done' as const,
            warning: 'No login machinery could be authored — journeys run logged-out only',
            affected_specs: [],
        },
    }

    it('builds e2e_journeys (title, spec_path fallback), e2e_reopened (counts > 0 only) and e2e_warnings', () => {
        const spec = makeSpec([specTask('t1'), specTask('t2')])
        const run = makeRun([doneTask('t1', 1), doneTask('t2', 2)], E2E_RUN)
        const report = buildPartialReport(run, spec, {now: NOW})

        expect(report.e2e_journeys).toEqual(['Buy an item and reach order confirmation', 'e2e/nav.spec.ts'])
        expect(report.e2e_reopened).toEqual(['t1'])
        expect(report.e2e_warnings).toEqual(['No login machinery could be authored — journeys run logged-out only'])
        expect(report.e2e_assessment_failure).toBeUndefined()
    })

    it('all narrative fields are absent for a run without an e2e phase (and their sections unrendered)', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {status: 'completed'})
        const report = buildPartialReport(run, spec, {now: NOW})

        expect(report.e2e_journeys).toBeUndefined()
        expect(report.e2e_reopened).toBeUndefined()
        expect(report.e2e_warnings).toBeUndefined()
        expect(report.e2e_assessment_failure).toBeUndefined()

        const md = renderPartialReportMarkdown(report)
        expect(md).not.toContain('End-to-end journeys')
        expect(md).not.toContain('Found by end-to-end')
        expect(md).not.toContain('End-to-end warnings')
        expect(md).not.toContain('End-to-end setup failed')
    })

    it('surfaces e2e_assessment_failure (D3c fail-loud) in build + both renderers', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([failedTask('t1', 'blocked-environmental', 'assessment failed the run')], {
            status: 'failed',
            e2e_assessment: {
                status: 'failed' as const,
                reason: 'The app never became reachable\n`npm run dev` exited 1 after 30s',
                affected_specs: [],
            },
        })
        const report = buildPartialReport(run, spec, {now: NOW})
        expect(report.e2e_assessment_failure).toBe('The app never became reachable\n`npm run dev` exited 1 after 30s')

        const md = renderPartialReportMarkdown(report)
        expect(md).toContain('## End-to-end setup failed before any task ran')
        expect(md).toContain('The app never became reachable')

        const comment = renderFailureComment(report)
        expect(comment).toContain('### End-to-end setup failed before any task ran')
    })

    it('splits a "<plain>\\n<detail>" reason: plain line reads standalone, detail fenced', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {
            status: 'failed',
            e2e_phase: {
                status: 'failed',
                reason:
                    'A pre-existing checkout journey broke and the run cannot repair it\n' +
                    'e2e adjudication: regression verdict — e2e/legacy.spec.ts: button gone',
                manifest: [],
                reopen_counts: {},
                ended_at: NOW,
            },
        })
        const md = renderPartialReportMarkdown(buildPartialReport(run, spec, {now: NOW}))

        expect(md).toContain(
            '## End-to-end verification failed\nA pre-existing checkout journey broke and the run cannot repair it\n```\n' +
                'e2e adjudication: regression verdict — e2e/legacy.spec.ts: button gone\n```'
        )
    })

    it('renders the journeys / found-by / warnings sections', () => {
        const spec = makeSpec([specTask('t1'), specTask('t2')])
        const run = makeRun([doneTask('t1', 1), doneTask('t2', 2)], E2E_RUN)
        const md = renderPartialReportMarkdown(buildPartialReport(run, spec, {now: NOW}))

        expect(md).toContain('## End-to-end journeys verified (2)')
        expect(md).toContain('- Buy an item and reach order confirmation')
        expect(md).toContain('## Found by end-to-end testing')
        expect(md).toContain('sent 1 task(s) back for fixes: `t1`')
        expect(md).toContain('## End-to-end warnings')
        expect(md).toContain('- No login machinery could be authored')
    })
})

describe('general warnings (S7, Decision 46 legacy pre-contract warn)', () => {
    const WARN = 'gates ran without a .factory/gates.json contract (legacy pre-contract run)'

    it('threads opts.warnings into the report and renders the ## Warnings section', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {status: 'completed'})
        const report = buildPartialReport(run, spec, {now: NOW, warnings: [WARN]})
        expect(report.warnings).toEqual([WARN])
        const md = renderPartialReportMarkdown(report)
        expect(md).toContain('## Warnings')
        expect(md).toContain(`- ${WARN}`)
    })

    it('field + section are absent when no warnings (incl. an explicit empty array)', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {status: 'completed'})
        expect(buildPartialReport(run, spec, {now: NOW}).warnings).toBeUndefined()
        const report = buildPartialReport(run, spec, {now: NOW, warnings: []})
        expect(report.warnings).toBeUndefined()
        expect(renderPartialReportMarkdown(report)).not.toContain('## Warnings')
    })
})

describe('cross-vendor absences (Δ U/S5 review independence)', () => {
    it('builds cross_vendor_absences in spec order from persisted task.cross_vendor_absent + renders the section', () => {
        const spec = makeSpec([specTask('t1'), specTask('t2'), specTask('t3')])
        const run = makeRun(
            [
                {...doneTask('t3', 3), cross_vendor_absent: {reason: 'codex execution failed: exit 1'}},
                doneTask('t2', 2),
                {
                    ...doneTask('t1', 1),
                    cross_vendor_absent: {reason: 'no cross-vendor model configured (codex.model)'},
                },
            ],
            {status: 'completed'}
        )
        const report = buildPartialReport(run, spec, {now: NOW})

        expect(report.cross_vendor_absences).toEqual([
            {task_id: 't1', reason: 'no cross-vendor model configured (codex.model)'},
            {task_id: 't3', reason: 'codex execution failed: exit 1'},
        ])

        const md = renderPartialReportMarkdown(report)
        expect(md).toContain('## Review independence')
        expect(md).toContain('2 task(s) were reviewed WITHOUT an independent second-vendor reviewer:')
        expect(md).toContain('- `t1` — no cross-vendor model configured (codex.model)')
        expect(md).toContain('- `t3` — codex execution failed: exit 1')
    })

    it('field + section are absent when every task had a second vendor', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {status: 'completed'})
        const report = buildPartialReport(run, spec, {now: NOW})

        expect(report.cross_vendor_absences).toBeUndefined()
        expect(renderPartialReportMarkdown(report)).not.toContain('Review independence')
    })
})

describe('failureCommentMarker', () => {
    it('embeds the run id in a hidden HTML comment', () => {
        expect(failureCommentMarker('run-1')).toBe('<!-- factory:run-failed:run-1 -->')
    })
})

describe('renderFailureComment', () => {
    it('leads with the marker and renders one block per fail with unmet criteria checkboxes', () => {
        const spec = makeSpec([specTask('t1'), specTask('t2')])
        const run = makeRun(
            [
                failedTask('t1', 'capability-budget', 'ladder exhausted at rung 2'),
                failedTask('t2', 'spec-defect', 'criterion unattainable'),
            ],
            {status: 'failed'}
        )
        const report = buildPartialReport(run, spec, {now: NOW})
        const body = renderFailureComment(report)

        // Marker is the very first line → finalize's dedup scan finds it on re-entry.
        expect(body.startsWith(failureCommentMarker('run-1'))).toBe(true)
        expect(body).toContain('Factory run `run-1` failed — 2 task(s) failed')
        expect(body).toContain('PRD left open for rescue/resume')
        // One block per failed task.
        expect(body).toContain('### `t1` — Title t1')
        expect(body).toContain('- **Class:** `capability-budget`')
        expect(body).toContain('- **Reason:** ladder exhausted at rung 2')
        expect(body).toContain('### `t2` — Title t2')
        expect(body).toContain('- **Class:** `spec-defect`')
        // Full acceptance criteria rendered as unmet checkboxes.
        expect(body).toContain('  - [ ] t1 criterion one')
        expect(body).toContain('  - [ ] t1 criterion two')
    })

    it('adds the self-heal line iff eligible (S10, Decision 48)', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([failedTask('t1', 'blocked-environmental', 'CI infra down')], {
            status: 'failed',
        })
        const report = buildPartialReport(run, spec, {now: NOW})
        expect(renderFailureComment(report, true)).toContain('factory rescue auto')
        expect(renderFailureComment(report)).not.toContain('factory rescue auto')
    })

    it('embeds the self-heal marker with the run id', () => {
        expect(selfHealCommentMarker('run-1')).toBe('<!-- factory:self-heal:run-1 -->')
    })

    it('includes branch + PR pointers when present', () => {
        const spec = makeSpec([specTask('t1')])
        const failed: TaskState = {
            ...failedTask('t1', 'blocked-environmental', 'CI infra down'),
            branch: 'factory/run-1/t1',
            pr_number: 7,
        }
        const run = makeRun([failed], {status: 'failed'})
        const report = buildPartialReport(run, spec, {now: NOW})
        const body = renderFailureComment(report)

        expect(body).toContain('- **Branch:** `factory/run-1/t1`')
        expect(body).toContain('- **PR:** #7')
    })

    it('surfaces the e2e veto section even with zero task failures (Decision 39)', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {
            status: 'failed',
            e2e_phase: {
                status: 'failed',
                reason: 'checkout: cap-exhausted critical',
                manifest: [],
                reopen_counts: {},
                ended_at: NOW,
            },
        })
        const report = buildPartialReport(run, spec, {now: NOW})
        const body = renderFailureComment(report)

        expect(body).toContain('### End-to-end verification failed')
        expect(body).toContain('checkout: cap-exhausted critical')
    })

    it('surfaces the Unmet PRD requirements block on a traceability veto (S9, Decision 47)', () => {
        const spec = makeSpec([specTask('t1')])
        const run = makeRun([doneTask('t1', 1)], {
            status: 'failed',
            traceability: {
                status: 'failed',
                reason: 'PRD requirements unmet: "returns 201"',
                verdicts: [
                    {requirement: 'checkout must work', verdict: 'met', evidence: 'checkout.ts:1'},
                    {requirement: 'returns 201', verdict: 'unmet', evidence: 'no 201 in the diff'},
                ],
                ended_at: NOW,
            },
        })
        const report = buildPartialReport(run, spec, {now: NOW})
        const body = renderFailureComment(report)

        expect(body).toContain('### Unmet PRD requirements')
        expect(body).toContain('PRD requirements unmet: "returns 201"')
        // Only the non-met rows, with the auditor's evidence.
        expect(body).toContain('- **returns 201** (`unmet`): no 201 in the diff')
        expect(body).not.toContain('checkout must work')
    })
})
