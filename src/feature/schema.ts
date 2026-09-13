import {createHash} from 'node:crypto'
import {z} from 'zod'
import {PrdSchema, SpecTaskSchema} from '../spec/schema.js'
import {executionOrder} from '../spec/execution.js'
import {extractPrdRequirements} from '../spec/gates.js'

export const VERSION = 2
export const REPAIR_PASSES = 3
export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
export const ShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/)
export const FeatureTaskSchema = SpecTaskSchema.extend({
    slice_id: IdSchema,
    requirement_ids: z.array(IdSchema).min(1),
})
export const FeatureSpecSchema = z
    .object({
        version: z.literal(VERSION),
        revision: z.number().int().positive(),
        base_sha: ShaSchema,
        prd: PrdSchema,
        spec_md: z.string().min(1),
        contracts: z.record(z.string()),
        tasks: z.array(FeatureTaskSchema).min(1),
    })
    .strict()
export type FeatureSpec = z.infer<typeof FeatureSpecSchema>
export type FeatureTask = z.infer<typeof FeatureTaskSchema>

export function digest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function validateFeatureSpec(raw: unknown): FeatureSpec {
    const spec = FeatureSpecSchema.parse(raw)
    spec.tasks = executionOrder(spec.tasks) as FeatureTask[]
    const requirements = extractPrdRequirements(spec.prd.body).map((text, index) => ({id: `R${index + 1}`, text}))
    if (requirements.length === 0) {
        throw new Error('PRD has no requirements')
    }
    const ids = new Set(requirements.map((row) => row.id))
    const covered = new Set<string>()
    for (const task of spec.tasks) {
        for (const id of task.requirement_ids) {
            if (!ids.has(id)) {
                throw new Error(`${task.task_id}: unknown requirement ${id}`)
            }
            covered.add(id)
        }
    }
    for (const id of ids) {
        if (!covered.has(id)) {
            throw new Error(`uncovered requirement ${id}`)
        }
    }
    return spec
}

export const StageSchema = z.enum([
    'prepare',
    'tests',
    'implement',
    'task-check',
    'task-review',
    'slice-check',
    'slice-review',
    'docs',
    'e2e-author',
    'feature-check',
    'feature-review',
    'acceptance',
    'confirm',
    'spec-repair',
    'spec-review',
    'deliver',
])
export type Stage = z.infer<typeof StageSchema>
const ClaimSchema = z.object({
    id: IdSchema,
    reviewer: z.string().min(1),
    severity: z.enum(['important', 'critical']),
    file: z.string().min(1),
    line: z.number().int().positive(),
    quote: z.string().min(10),
    claim: z.string().min(1).max(300),
})
export type Claim = z.infer<typeof ClaimSchema>
export const AttemptSchema = z.object({
    id: IdSchema,
    driver: z.string().min(1),
    stage: StageSchema,
    base_sha: ShaSchema,
    head_sha: ShaSchema,
    spec_digest: z.string(),
    worktree: z.string(),
    roles: z.array(z.string()),
    issued_at: z.string(),
    /** Roles whose staged result was missing at explicit recovery; the next execute re-issues only these. */
    redispatch: z.array(z.string()).optional(),
})
export type Attempt = z.infer<typeof AttemptSchema>
export const FeatureRunSchema = z
    .object({
        version: z.literal(VERSION),
        run_id: IdSchema,
        repo: z.string().min(1),
        root: z.string(),
        branch: z.string(),
        worktree: z.string(),
        base_branch: z.string(),
        remote: z.string(),
        ship_mode: z.enum(['live', 'no-ship']),
        debug: z.boolean(),
        e2e: z.boolean(),
        ignore_quota: z.boolean(),
        owner_session: z.string().optional(),
        spec: FeatureSpecSchema,
        spec_digest: z.string(),
        status: z.enum([
            'running',
            'parked',
            'waiting',
            'awaiting-merge',
            'ready-for-review',
            'completed',
            'cancelled',
        ]),
        wait_since: z.string().optional(),
        stop_reason: z
            .object({
                kind: z.enum(['operator', 'quota', 'ci', 'environment', 'producer', 'spec', 'context']),
                message: z.string(),
            })
            .optional(),
        stage: StageSchema,
        task_index: z.number().int().min(0),
        accepted_sha: ShaSchema,
        verified_feature: z.object({head_sha: ShaSchema, spec_digest: z.string()}).optional(),
        task_base_sha: ShaSchema,
        slice_base_sha: ShaSchema,
        attempts: z.record(z.number().int().min(0)),
        in_flight: AttemptSchema.optional(),
        checkpoints: z.array(z.object({task_id: IdSchema, head_sha: ShaSchema, spec_digest: z.string()})),
        answers: z.array(z.object({task_id: IdSchema, question: z.string(), answer: z.string(), at: z.string()})),
        question: z.string().optional(),
        feedback: z.array(z.string()),
        claims: z.array(ClaimSchema),
        after_confirm: StageSchema.optional(),
        candidate_satisfied: z.boolean(),
        repaired_spec: FeatureSpecSchema.optional(),
        delivery: z.object({
            pr_number: z.number().int().positive().optional(),
            head_sha: ShaSchema.optional(),
            url: z.string().optional(),
            outcome: z.enum(['merged', 'no-change', 'review']).optional(),
        }),
        audit: z.array(
            z.object({at: z.string(), event: z.string(), stage: StageSchema, head_sha: ShaSchema, details: z.unknown()})
        ),
    })
    .strict()
export type FeatureRun = z.infer<typeof FeatureRunSchema>
export function terminal(run: FeatureRun): boolean {
    return ['completed', 'ready-for-review', 'cancelled'].includes(run.status)
}

export const ResultSchema = z
    .object({
        attempt_id: IdSchema,
        spec_digest: z.string(),
        head_sha: ShaSchema,
        status: z.enum(['done', 'already-satisfied', 'needs-context', 'spec-defect', 'blocked']),
        message: z.string().optional(),
        reviews: z.array(z.object({reviewer: z.string(), claims: z.array(ClaimSchema)})).optional(),
        confirmations: z
            .array(z.object({id: IdSchema, confirmed: z.boolean(), evidence: z.string().min(10)}))
            .optional(),
        acceptance: z.array(z.object({id: z.string(), met: z.boolean(), evidence: z.string().min(10)})).optional(),
        repaired_spec: FeatureSpecSchema.optional(),
    })
    .strict()
export type FeatureResult = z.infer<typeof ResultSchema>

export type FeatureAction =
    | {kind: 'execute'; run_id: string; attempt: Attempt; staged: Record<string, string>; prompt: string}
    | {kind: 'wait'; run_id: string; reason: string; retry_after_seconds: number}
    | {kind: 'park'; run_id: string; reason: string}
    | {kind: 'terminal'; run_id: string; status: FeatureRun['status']; delivery: FeatureRun['delivery']}
