/* eslint-disable security/detect-non-literal-fs-filename -- validated run IDs and engine-owned data paths */
import {access, mkdir, readFile, readdir} from 'node:fs/promises'
import {join} from 'node:path'
import {ZodError} from 'zod'
import {atomicWriteFile} from '../shared/atomic-write.js'
import {withFileLock, DEFAULT_FILE_LOCK_TUNING} from '../shared/file-lock.js'
import {isEnoent} from '../shared/fs-errors.js'
import {
    FeatureRunSchema,
    ResultSchema,
    IdSchema,
    digest,
    terminal,
    type Attempt,
    type FeatureRun,
    type FeatureResult,
} from './schema.js'

/** Per-role staged results: `{missing}` means not every role has a parseable file yet. */
export type Staged = {result: FeatureResult} | {missing: string[]}

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

    /**
     * Staged results live outside `runs-v2/**` so the driver session may write them
     * (engine state stays read-only to agents). The file's existence is the submission.
     */
    stagedPaths(id: string, attempt: Attempt, roles: readonly string[] = attempt.roles): Record<string, string> {
        const dir = join(this.dataDir, 'staged-v2', IdSchema.parse(id), IdSchema.parse(attempt.id))
        return Object.fromEntries(roles.map((role) => [role, join(dir, `${IdSchema.parse(role)}.json`)]))
    }

    async stage(id: string, attempt: Attempt, roles?: readonly string[]): Promise<Record<string, string>> {
        const paths = this.stagedPaths(id, attempt, roles)
        await mkdir(join(this.dataDir, 'staged-v2', id, attempt.id), {recursive: true})
        return paths
    }

    /** Roles whose staged file exists (parseability not checked). */
    async stagedPresent(id: string, attempt: Attempt): Promise<string[]> {
        const present: string[] = []
        for (const [role, path] of Object.entries(this.stagedPaths(id, attempt))) {
            try {
                await access(path)
                present.push(role)
            } catch (error) {
                if (!isEnoent(error)) {
                    throw error
                }
            }
        }
        return present
    }

    /**
     * Read every role's staged file and merge them into one attempt result. A missing,
     * half-written or schema-invalid file reads as "not yet"; only explicit recovery
     * judges it. Identity fields must agree; any non-done status wins.
     */
    async staged(id: string, attempt: Attempt): Promise<Staged> {
        const parts: FeatureResult[] = []
        const missing: string[] = []
        for (const [role, path] of Object.entries(this.stagedPaths(id, attempt))) {
            try {
                parts.push(ResultSchema.parse(JSON.parse(await readFile(path, 'utf8'))))
            } catch (error) {
                if (isEnoent(error) || error instanceof SyntaxError || error instanceof ZodError) {
                    missing.push(role)
                } else {
                    throw error
                }
            }
        }
        const first = parts[0]
        if (missing.length || first === undefined) {
            return {missing}
        }
        if (
            parts.some(
                (part) =>
                    part.attempt_id !== first.attempt_id ||
                    part.spec_digest !== first.spec_digest ||
                    part.head_sha !== first.head_sha
            )
        ) {
            throw new Error('staged results disagree on attempt identity or HEAD')
        }
        const halted = parts.find((part) => part.status !== 'done')
        const reviews = parts.flatMap((part) => part.reviews ?? [])
        return {
            result: {
                ...first,
                ...(halted ? {status: halted.status, message: halted.message} : {}),
                ...(reviews.length ? {reviews} : {}),
            },
        }
    }
}

export function age(from: string, now: string): string {
    const minutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(from)) / 60_000))
    return minutes < 60
        ? `${minutes}m`
        : minutes < 1440
          ? `${Math.round(minutes / 60)}h`
          : `${Math.round(minutes / 1440)}d`
}

export function nextCommand(run: FeatureRun): string {
    if (terminal(run)) {
        return 'none (terminal)'
    }
    if (run.status === 'parked') {
        return `factory resume --run ${run.run_id}${run.question !== undefined ? ' --answer <text>' : ''}${run.in_flight ? ' --recover (after its agent has stopped)' : ''}`
    }
    return `factory next-action --run ${run.run_id} --driver <session>`
}

export function renderLedger(run: FeatureRun, live: {now?: string; staged?: string[]} = {}): string {
    const attempt = run.in_flight
    return [
        `# Feature ${run.run_id}`,
        '',
        `Status: ${run.status} (persisted lifecycle, not proof of a live worker). Resume: ${run.stage}, task ${run.task_index + 1}.`,
        `Branch: ${run.branch}. Accepted HEAD: ${run.accepted_sha}. Spec: ${run.spec_digest}.`,
        run.stop_reason ? `Stopped: ${run.stop_reason.kind}: ${run.stop_reason.message}` : '',
        attempt
            ? `In flight: ${attempt.stage} [${attempt.roles.join(', ')}] issued ${attempt.issued_at}${live.now !== undefined ? ` (${age(attempt.issued_at, live.now)} ago)` : ''}.` +
              (live.staged
                  ? ` Staged results: ${live.staged.length}/${attempt.roles.length}${live.staged.length ? ` (${live.staged.join(', ')})` : ''}.`
                  : '') +
              (attempt.redispatch ? ` Redispatch: ${attempt.redispatch.join(', ')}.` : '')
            : '',
        `Next: ${nextCommand(run)}`,
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
