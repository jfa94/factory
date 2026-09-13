/* eslint-disable security/detect-non-literal-fs-filename -- validated run IDs and engine-owned data paths */
import {readFile, readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {atomicWriteFile} from '../shared/atomic-write.js'
import {withFileLock, DEFAULT_FILE_LOCK_TUNING} from '../shared/file-lock.js'
import {isEnoent} from '../shared/fs-errors.js'
import {FeatureRunSchema, ResultSchema, IdSchema, digest, type FeatureRun, type FeatureResult} from './schema.js'

export class FeatureStore {
    constructor(readonly dataDir: string) {}

    dir(id: string): string {
        return join(this.dataDir, 'runs-v2', IdSchema.parse(id))
    }

    async read(id: string): Promise<FeatureRun> {
        let raw: unknown
        try {
            raw = JSON.parse(await readFile(join(this.dir(id), 'state.json'), 'utf8'))
        } catch (error) {
            if (isEnoent(error)) {
                throw new Error(
                    `run ${id} is missing or uses an unsupported version; start a fresh v2 run (legacy artifacts are preserved)`
                )
            }
            throw error
        }
        const run = FeatureRunSchema.parse(raw)
        if (run.run_id !== id || digest(run.spec) !== run.spec_digest) {
            throw new Error(`run ${id}: corrupt identity or spec snapshot`)
        }
        return run
    }

    async list(): Promise<FeatureRun[]> {
        let names: string[]
        try {
            names = await readdir(join(this.dataDir, 'runs-v2'))
        } catch (error) {
            if (isEnoent(error)) {
                return []
            }
            throw error
        }
        return Promise.all(names.filter((name) => IdSchema.safeParse(name).success).map((name) => this.read(name)))
    }

    async write(run: FeatureRun): Promise<void> {
        const checked = FeatureRunSchema.parse(run)
        if (digest(checked.spec) !== checked.spec_digest) {
            throw new Error('spec snapshot digest mismatch')
        }
        const dir = this.dir(run.run_id)
        await atomicWriteFile(join(dir, 'state.json'), JSON.stringify(checked, null, 2) + '\n')
        await atomicWriteFile(join(dir, 'ledger.md'), renderLedger(checked))
    }

    async withRepo<T>(repo: string, fn: () => Promise<T>): Promise<T> {
        const dir = join(this.dataDir, 'locks-v2')
        return withFileLock(
            {
                dir,
                lockfile: join(dir, digest(repo)),
                label: repo,
                dirPolicy: 'create',
                tuning: DEFAULT_FILE_LOCK_TUNING,
            },
            fn
        )
    }

    async recordResult(id: string, result: FeatureResult): Promise<void> {
        const checked = ResultSchema.parse(result)
        await atomicWriteFile(join(this.dir(id), 'results', `${checked.attempt_id}.json`), JSON.stringify(checked))
    }

    async result(id: string, attemptId: string): Promise<FeatureResult | undefined> {
        try {
            return ResultSchema.parse(
                JSON.parse(await readFile(join(this.dir(id), 'results', `${IdSchema.parse(attemptId)}.json`), 'utf8'))
            )
        } catch (error) {
            if (isEnoent(error)) {
                return undefined
            }
            throw error
        }
    }
}

export function renderLedger(run: FeatureRun): string {
    return [
        `# Feature ${run.run_id}`,
        '',
        `Status: ${run.status}. Resume: ${run.stage}, task ${run.task_index + 1}.`,
        `Branch: ${run.branch}. Accepted HEAD: ${run.accepted_sha}. Spec: ${run.spec_digest}.`,
        run.stop_reason ? `Stopped: ${run.stop_reason.kind}: ${run.stop_reason.message}` : '',
        '',
        '## Accepted tasks',
        '',
        ...run.checkpoints.map((row) => `- ${row.task_id}: ${row.head_sha}`),
        '',
        '## Answers',
        '',
        ...run.answers.map((row) => `- ${row.task_id}: ${row.question}\n  Answer: ${row.answer}`),
        '',
        '## Audit',
        '',
        ...run.audit.map(
            (row) => `- ${row.at} ${row.stage}: ${row.event} (${row.head_sha})\n  ${JSON.stringify(row.details)}`
        ),
        '',
    ].join('\n')
}
