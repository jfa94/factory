// src/driver/results.ts
/**
 * The `factory drive --results <file>` input — what a driver collected from the
 * agents the previous spawn envelope named. Exactly one of `producer` / `reviews`
 * is present (matching the envelope's `expects`); `holdout` may accompany
 * `reviews` when the envelope carried a sidecar. Parsed LOUD (Zod strict).
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// SpawnStage + ResultKey
// ---------------------------------------------------------------------------

/**
 * The only stages that can appear in a spawn envelope (preflight only advances;
 * ship never spawns). Defined here so results.ts does not import coroutine.ts.
 */
export const SPAWN_STAGES = ["tests", "exec", "verify"] as const;
export type SpawnStage = (typeof SPAWN_STAGES)[number];

/**
 * Echo token emitted by the spawn envelope and mirrored verbatim in DriveResults.
 * The record gate validates stage === cursor stage AND rung === task.escalation_rung
 * before applying any mutation, making at-least-once delivery exactly-once at
 * the record site (stale or duplicate results are rejected LOUD instead of
 * double-recording).
 */
export const ResultKeySchema = z
  .object({ stage: z.enum(SPAWN_STAGES), rung: z.number().int().min(0) })
  .strict();

export type ResultKey = z.infer<typeof ResultKeySchema>;

const ProducerResultSchema = z.object({ status: z.string().min(1) }).strict();
const HoldoutResultSchema = z.object({ raw: z.string().min(1) }).strict();
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
                note: z.string(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    crossVendorAbsent: z
      .object({ reason: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

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
  });

export type DriveResults = z.infer<typeof DriveResultsSchema>;

/** Parse a raw `--results` document. Throws (Zod) on any shape violation. */
export function parseDriveResults(raw: unknown): DriveResults {
  return DriveResultsSchema.parse(raw);
}

/**
 * Type guard: true iff `stage` is one of the three spawn-capable stages.
 * Co-located with SPAWN_STAGES so the constant and the guard cannot drift.
 */
export function isSpawnStage(stage: string): stage is SpawnStage {
  return (SPAWN_STAGES as readonly string[]).includes(stage);
}
