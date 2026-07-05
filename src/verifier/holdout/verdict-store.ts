/**
 * WS10 / Task C — the HOLDOUT-VERDICT store (the holdout → review record hand-off).
 *
 * The orchestrator (`factory next-action --results`) records verify in two steps that hand off
 * through this store: `applyRecordHoldout` parses the out-of-band holdout-validator's
 * raw output into {@link HoldoutVerdict}s and PERSISTS them here; `applyRecordReviews`
 * reads them back and RE-DERIVES the holdout gate evidence (`checkHoldout` →
 * `holdoutEvidence`) at record time. This is the sanctioned derive-don't-store EXCEPTION
 * (Δ V): the holdout verdicts come from an AGENT, so — exactly like a raw review — the
 * agent's RAW assessment is stored and the verdict is recomputed on read, never a
 * stored boolean.
 *
 * The verdicts live in the SAME Δ Y confined subtree as the answer key
 * (`runs/<run_id>/holdouts/<task_id>.verdicts.json`): they reveal the withheld
 * criteria text, so they must stay out of an implementer worktree's read reach too.
 *
 * Two impls mirror {@link import("./store.js").HoldoutStore}:
 * {@link InMemoryHoldoutVerdictStore} (units) and {@link FsHoldoutVerdictStore} (the
 * persisted path — the verdicts survive to the review record even across a `drive`
 * crash-resume, and stay inside the Δ Y confined subtree).
 */
/* eslint-disable security/detect-non-literal-fs-filename -- fs seam: paths are internal derived run/spec/state/repo paths, never external input; runtime write-danger is covered by the TCB write-deny hook */
import {mkdir, readFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'
import {z} from 'zod'
import {atomicWriteFile} from '../../shared/atomic-write.js'
import {validateId} from '../../shared/index.js'
import {parseJson, stringifyJson} from '../../shared/json.js'
import {runDir} from '../../core/state/index.js'
import type {HoldoutVerdict} from './validate.js'

/**
 * The on-disk shape of a persisted verdict array. A read-back is LOUD (throws) on a
 * malformed/forged file — the store re-validates what it reads, never trusts it. The
 * inferred type is assignable to {@link HoldoutVerdict}, so a drift in the validate-
 * domain type breaks this at compile time.
 */
const HoldoutVerdictSchema = z
    .object({
        criterion: z.string(),
        satisfied: z.boolean(),
        evidence: z.string(),
    })
    .strict()
const HoldoutVerdictsSchema = z.array(HoldoutVerdictSchema)

// Compile-time drift pin: the schema's inferred output must stay assignable to the
// validate-domain {@link HoldoutVerdict}. If either drifts this line fails to
// typecheck — making the docblock's "breaks at compile time" guarantee real.
const _holdoutVerdictPin: z.ZodType<HoldoutVerdict> = HoldoutVerdictSchema
void _holdoutVerdictPin

/**
 * Persist + retrieve the per-task holdout VERDICTS (the validator agent's parsed
 * assessment). `put` is idempotent (overwrites) so a re-validated verify round
 * replaces the stale verdicts; `get` is LOUD if absent.
 */
export interface HoldoutVerdictStore {
    put(runId: string, taskId: string, verdicts: readonly HoldoutVerdict[]): Promise<void>
    get(runId: string, taskId: string): Promise<readonly HoldoutVerdict[]>
    has(runId: string, taskId: string): Promise<boolean>
}

/** In-memory store: units. Keyed by `runId\0taskId`. */
export class InMemoryHoldoutVerdictStore implements HoldoutVerdictStore {
    private readonly verdicts = new Map<string, readonly HoldoutVerdict[]>()

    private key(runId: string, taskId: string): string {
        return `${runId} ${taskId}`
    }

    put(runId: string, taskId: string, verdicts: readonly HoldoutVerdict[]): Promise<void> {
        this.verdicts.set(this.key(runId, taskId), [...verdicts])
        return Promise.resolve()
    }

    get(runId: string, taskId: string): Promise<readonly HoldoutVerdict[]> {
        const v = this.verdicts.get(this.key(runId, taskId))
        if (v === undefined) {
            return Promise.reject(
                new Error(`InMemoryHoldoutVerdictStore: no verdicts for task '${taskId}' in run '${runId}'`)
            )
        }
        return Promise.resolve(v)
    }

    has(runId: string, taskId: string): Promise<boolean> {
        return Promise.resolve(this.verdicts.has(this.key(runId, taskId)))
    }
}

/**
 * Fs-backed store under `runs/<run_id>/holdouts/<task_id>.verdicts.json` (the Δ Y
 * confined subtree, alongside the answer key). Atomic writes via the shared helper.
 */
export class FsHoldoutVerdictStore implements HoldoutVerdictStore {
    constructor(private readonly dataDir: string) {}

    private path(runId: string, taskId: string): string {
        const safe = validateId(taskId, 'task_id')
        return join(runDir(this.dataDir, runId), 'holdouts', `${safe}.verdicts.json`)
    }

    async put(runId: string, taskId: string, verdicts: readonly HoldoutVerdict[]): Promise<void> {
        const path = this.path(runId, taskId)
        await mkdir(dirname(path), {recursive: true})
        await atomicWriteFile(path, stringifyJson([...verdicts]))
    }

    async get(runId: string, taskId: string): Promise<readonly HoldoutVerdict[]> {
        const path = this.path(runId, taskId)
        const raw = await readFile(path, 'utf8')
        return HoldoutVerdictsSchema.parse(parseJson(raw, path))
    }

    async has(runId: string, taskId: string): Promise<boolean> {
        try {
            await readFile(this.path(runId, taskId), 'utf8')
            return true
        } catch {
            return false
        }
    }
}
