import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {emitMetric, readMetrics, recordRunFinalized} from './telemetry.js'
import {runMetricsPath, runsRoot} from '../core/state/paths.js'
import {captureStream} from '../cli/test-helpers.js'
import type {PartialRunReport} from './partial-report.js'
import {at} from '../shared/index.js'

let dataDir: string
const RUN = 'run-1'
const NOW = '2026-02-02T12:00:00.000Z'

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'telemetry-test-'))
})
afterEach(async () => {
    await rm(dataDir, {recursive: true, force: true})
})

describe('emitMetric / readMetrics', () => {
    it('appends a stamped record readable by readMetrics', async () => {
        await emitMetric(dataDir, RUN, 'task.shipped', {task_id: 't1'}, {now: NOW})
        const metrics = await readMetrics(dataDir, RUN)
        expect(metrics).toEqual([{ts: NOW, run_id: RUN, event: 'task.shipped', data: {task_id: 't1'}}])
    })

    it('omits the data key when no payload is given', async () => {
        const rec = await emitMetric(dataDir, RUN, 'run.started', undefined, {now: NOW})
        expect(rec).toEqual({ts: NOW, run_id: RUN, event: 'run.started'})
        expect('data' in rec).toBe(false)
    })

    it('accumulates multiple metrics in emit order', async () => {
        await emitMetric(dataDir, RUN, 'a', undefined, {now: NOW})
        await emitMetric(dataDir, RUN, 'b', undefined, {now: NOW})
        expect((await readMetrics(dataDir, RUN)).map((m) => m.event)).toEqual(['a', 'b'])
    })

    it('returns [] when a run emitted no metrics', async () => {
        expect(await readMetrics(dataDir, RUN)).toEqual([])
    })

    it('writes to the run-store metrics path', async () => {
        await emitMetric(dataDir, RUN, 'x', undefined, {now: NOW})
        const metrics = await readMetrics(dataDir, RUN)
        expect(metrics).toHaveLength(1)
        expect(runMetricsPath(dataDir, RUN)).toContain(join('runs', RUN, 'metrics.jsonl'))
    })

    it('swallows an IO failure rather than breaking the run', async () => {
        // Plant a FILE where the run dir should be so mkdir(runs/<run>) fails.
        await mkdir(runsRoot(dataDir), {recursive: true})
        await writeFile(join(runsRoot(dataDir), RUN), 'blocker', 'utf8')

        // Must not throw despite the unwritable path.
        const rec = await emitMetric(dataDir, RUN, 'task.dropped', {task_id: 't1'}, {now: NOW})
        expect(rec.event).toBe('task.dropped')
    })
})

describe('recordRunFinalized', () => {
    function report(overrides: Partial<PartialRunReport> = {}): PartialRunReport {
        return {
            run_id: RUN,
            run_status: 'failed',
            spec_id: '42-checkout',
            issue_number: 42,
            repo: 'acme/widgets',
            generated_at: NOW,
            totals: {total: 2, shipped: 1, failed: 1, incomplete: 0},
            shipped: [{task_id: 't1', title: 'T1'}],
            failures: [
                {
                    task_id: 't2',
                    title: 'T2',
                    failure_class: 'capability-budget',
                    failure_reason: 'exhausted',
                    unmet_criteria: ['c1'],
                },
            ],
            incomplete: [],
            ...overrides,
        }
    }

    it('emits a run.finalized line plus one task.dropped per failure', async () => {
        await recordRunFinalized(dataDir, report(), {now: NOW})
        const metrics = await readMetrics(dataDir, RUN)

        expect(metrics.map((m) => m.event)).toEqual(['run.finalized', 'task.dropped'])
        expect(at(metrics, 0).data).toMatchObject({
            status: 'failed',
            totals: {total: 2, shipped: 1, failed: 1, incomplete: 0},
        })
        expect(at(metrics, 1).data).toEqual({task_id: 't2', failure_class: 'capability-budget'})
    })

    it('emits only run.finalized for a completed run with no failures', async () => {
        await recordRunFinalized(
            dataDir,
            report({
                run_status: 'completed',
                totals: {total: 1, shipped: 1, failed: 0, incomplete: 0},
                failures: [],
            }),
            {now: NOW}
        )
        const metrics = await readMetrics(dataDir, RUN)
        expect(metrics.map((m) => m.event)).toEqual(['run.finalized'])
    })

    // --- WS9: end-of-run dropped-write counter (telemetry loss must be detectable) ---
    async function captureStderr<T>(fn: () => Promise<T>): Promise<{result: T; stderr: string}> {
        const saved = process.env.FACTORY_LOG_LEVEL
        process.env.FACTORY_LOG_LEVEL = 'info' // force warn-level through
        const cap = captureStream(process.stderr)
        try {
            const result = await fn()
            return {result, stderr: cap.read()}
        } finally {
            cap.restore()
            if (saved === undefined) {
                delete process.env.FACTORY_LOG_LEVEL
            } else {
                process.env.FACTORY_LOG_LEVEL = saved
            }
        }
    }

    it('warns once with the aggregate count when metric writes are dropped', async () => {
        // Plant a FILE where the run dir should be so every metric write for this run fails.
        await mkdir(runsRoot(dataDir), {recursive: true})
        await writeFile(join(runsRoot(dataDir), RUN), 'blocker', 'utf8')

        const {stderr} = await captureStderr(() => recordRunFinalized(dataDir, report(), {now: NOW}))

        // report() carries 1 failure → run.finalized + 1 task.dropped = 2 attempted writes,
        // both dropped against the blocked path → exactly one aggregate warn naming the count.
        expect(stderr).toMatch(/telemetry: 2 metric write\(s\) dropped/)
    })

    it('does not warn about dropped writes when telemetry is healthy', async () => {
        const {stderr} = await captureStderr(() => recordRunFinalized(dataDir, report(), {now: NOW}))
        expect(stderr).not.toMatch(/metric write\(s\) dropped/)
    })
})
