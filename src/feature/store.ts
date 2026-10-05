/* eslint-disable security/detect-non-literal-fs-filename -- validated run IDs and engine-owned data paths */
import {access, mkdir, readFile, readdir, rename} from 'node:fs/promises'
import {join} from 'node:path'
import {ZodError} from 'zod'
import {atomicWriteFile} from '../shared/atomic-write.js'
import {withFileLock, DEFAULT_FILE_LOCK_TUNING} from '../shared/file-lock.js'
import {isEnoent} from '../shared/fs-errors.js'
import {unwrapJson} from '../shared/json.js'
import {
    AgentResultSchema,
    FeatureRunSchema,
    ResultSchema,
    IdSchema,
    digest,
    terminal,
    type Attempt,
    type FeatureRun,
    type AgentResult,
    type FeatureResult,
} from './schema.js'

/** Per-role staged results: `{missing}` means not every role has a usable file yet. */
/** `invalid` names present files that are unparseable or schema-invalid ("finished wrong", not "still running"). */
export type Staged = {result: FeatureResult} | {missing: string[]; invalid: Record<string, string>}

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

    /** Readable runs; a run whose state is unreadable, invalid or another version is skipped with a warning. */
    async list(): Promise<FeatureRun[]> {
        const {runs, skipped} = await this.scan()
        for (const [id, why] of skipped) {
            process.stderr.write(`Factory: skipping unreadable run ${id}: ${why}\n`)
        }
        return runs
    }

    /** Ids of the runs `list()` skips. */
    async skipped(): Promise<string[]> {
        return (await this.scan()).skipped.map(([id]) => id)
    }

    private async scan(): Promise<{runs: FeatureRun[]; skipped: [string, string][]}> {
        let names: string[]
        try {
            names = await readdir(join(this.dataDir, 'runs-v2'))
        } catch (error) {
            if (isEnoent(error)) {
                return {runs: [], skipped: []}
            }
            throw error
        }
        const runs: FeatureRun[] = []
        const skipped: [string, string][] = []
        for (const name of names.filter((name) => IdSchema.safeParse(name).success)) {
            try {
                runs.push(await this.read(name))
            } catch (error) {
                skipped.push([name, error instanceof Error ? error.message : String(error)])
            }
        }
        return {runs, skipped}
    }

    async exists(id: string): Promise<boolean> {
        try {
            await access(this.dir(id))
            return true
        } catch (error) {
            if (isEnoent(error)) {
                return false
            }
            throw error
        }
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

    async recordResult(id: string, attemptId: string, result: FeatureResult): Promise<void> {
        const checked = ResultSchema.parse(result)
        await atomicWriteFile(
            join(this.dir(id), 'results', `${IdSchema.parse(attemptId)}.json`),
            JSON.stringify(checked)
        )
    }

    /** The brief each role reads; it sits beside the result file but never counts as one. */
    briefPath(id: string, attempt: Attempt, role: string): string {
        return join(
            this.dataDir,
            'staged-v2',
            IdSchema.parse(id),
            IdSchema.parse(attempt.id),
            `${IdSchema.parse(role)}.brief.md`
        )
    }

    async writeBrief(id: string, attempt: Attempt, role: string, body: string): Promise<string> {
        const path = this.briefPath(id, attempt, role)
        await atomicWriteFile(path, body)
        return path
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

    /** Move a rejected role's staged file aside as evidence; the role's path is free for its re-issue. */
    async rejectStaged(id: string, attempt: Attempt, role: string, n: number): Promise<void> {
        const path = this.stagedPaths(id, attempt, [role])[role] ?? ''
        await rename(path, path.replace(/\.json$/, `.rejected-${n}.json`))
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
     * Read every role's staged file and merge them into one attempt result. A missing file
     * reads as "not yet"; an unparseable (including empty) or schema-invalid one is also
     * named in `invalid`. Reviewer identity is bound from the path; any non-done status wins.
     */
    async staged(id: string, attempt: Attempt): Promise<Staged> {
        const parts: [string, AgentResult][] = []
        const missing: string[] = []
        const invalid: Record<string, string> = {}
        for (const [role, path] of Object.entries(this.stagedPaths(id, attempt))) {
            try {
                parts.push([role, AgentResultSchema.parse(JSON.parse(unwrapJson(await readFile(path, 'utf8'))))])
            } catch (error) {
                if (isEnoent(error)) {
                    missing.push(role)
                } else if (error instanceof SyntaxError) {
                    missing.push(role)
                    invalid[role] = `unparseable JSON: ${error.message}`
                } else if (error instanceof ZodError) {
                    missing.push(role)
                    invalid[role] = error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
                } else {
                    throw error
                }
            }
        }
        if (missing.length || parts.length === 0) {
            return {missing, invalid}
        }
        const reviews = parts.flatMap(([role, part]) =>
            part.claims
                ? [
                      {
                          reviewer: role,
                          claims: part.claims.map((claim, n) => ({id: `${role}.${n + 1}`, reviewer: role, ...claim})),
                      },
                  ]
                : []
        )
        const merged: FeatureResult = {status: 'done'}
        for (const [, {claims: _claims, ...part}] of parts) {
            Object.assign(merged, part, {status: merged.status})
        }
        const halted = parts.find(([, part]) => part.status !== 'done')?.[1]
        return {
            result: {
                ...merged,
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
