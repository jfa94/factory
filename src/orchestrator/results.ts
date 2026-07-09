// src/orchestrator/results.ts
/**
 * The `factory next-action --results <file>` input — what a orchestrator collected from the
 * agents the previous spawn envelope named. Exactly one of `producer` / `reviews`
 * is present (matching the envelope's `expects`); `holdout` may accompany
 * `reviews` when the envelope carried a holdout. Parsed LOUD (Zod strict).
 */
import {z} from 'zod'
import {SPAWN_PHASES} from '../types/phases-vocab.js'

// ---------------------------------------------------------------------------
// SpawnPhase + ResultKey
// ---------------------------------------------------------------------------

/**
 * The only phases that can appear in a spawn envelope (preflight only advances;
 * ship never spawns). Re-exported from the zero-import phases-vocab leaf so this
 * module stays a single source of truth for consumers (orchestrator, tests).
 */
export {SPAWN_PHASES}
export type SpawnPhase = (typeof SPAWN_PHASES)[number]

/**
 * Echo token emitted by the spawn envelope and mirrored verbatim in DriveResults.
 * The record gate validates phase === cursor phase AND rung === task.escalation_rung
 * before applying any mutation, making at-least-once delivery exactly-once at
 * the record site (stale or duplicate results are rejected LOUD instead of
 * double-recording).
 */
export const ResultKeySchema = z.object({phase: z.enum(SPAWN_PHASES), rung: z.number().int().min(0)}).strict()

export type ResultKey = z.infer<typeof ResultKeySchema>

const ProducerResultSchema = z.object({status: z.string().min(1)}).strict()
const HoldoutResultSchema = z.object({raw: z.string().min(1)}).strict()
const ReviewsResultSchema = z
    .object({
        reviews: z.array(z.unknown()).min(1),
        verifications: z.array(
            z
                .object({
                    reviewer: z.string().min(1),
                    verdicts: z.array(
                        z
                            .object({
                                file: z.string().min(1),
                                line: z.number().int().positive(),
                                holds: z.boolean(),
                                // `.min(1)` is hygiene, not an anti-fabrication measure: a runner
                                // willing to synthesise `holds` will synthesise a note with it.
                                // What it catches is a BROKEN verifier agent — an empty note means
                                // no justification was reached, and recording that as a verdict is
                                // worse than failing the parse LOUD.
                                note: z.string().min(1),
                            })
                            .strict()
                    ),
                })
                .strict()
        ),
        crossVendorAbsent: z
            .object({reason: z.string().min(1)})
            .strict()
            .optional(),
    })
    .strict()

export const DriveResultsSchema = z
    .object({
        result_key: ResultKeySchema,
        producer: ProducerResultSchema.optional(),
        holdout: HoldoutResultSchema.optional(),
        reviews: ReviewsResultSchema.optional(),
    })
    .strict()
    .refine((r) => (r.producer !== undefined) !== (r.reviews !== undefined), {
        message: "drive results must carry exactly one of 'producer' or 'reviews'",
    })
    .refine((r) => r.holdout === undefined || r.reviews !== undefined, {
        message: "'holdout' results only accompany 'reviews'",
    })

export type DriveResults = z.infer<typeof DriveResultsSchema>

/** Parse a raw `--results` document. Throws (Zod) on any shape violation. */
export function parseDriveResults(raw: unknown): DriveResults {
    return DriveResultsSchema.parse(raw)
}

/**
 * Type guard: true iff `phase` is one of the three spawn-capable phases.
 * Co-located with SPAWN_PHASES so the constant and the guard cannot drift.
 */
export function isSpawnPhase(phase: string): phase is SpawnPhase {
    return (SPAWN_PHASES as readonly string[]).includes(phase)
}
