// src/driver/results.ts
/**
 * The `factory drive --results <file>` input — what a driver collected from the
 * agents the previous spawn envelope named. Exactly one of `producer` / `reviews`
 * is present (matching the envelope's `expects`); `holdout` may accompany
 * `reviews` when the envelope carried a sidecar. Parsed LOUD (Zod strict).
 */
import { z } from "zod";

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
