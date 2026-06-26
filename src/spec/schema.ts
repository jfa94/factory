/**
 * WS5 — Zod schemas for the DURABLE on-disk spec artifact.
 *
 * This is NOT the runtime `TaskState` (the frozen WS1 seam): `TaskState` carries
 * only the producer dial (`risk_tier`) and live status. The DURABLE spec task,
 * by contrast, carries the spec-time payload — acceptance criteria, files, tests,
 * dependencies, and the judged risk tier + rationale — that lives in the spec
 * store's `tasks.json` and is reused across runs (Δ X).
 *
 * Decision 25 — the SINGLE producer dial. `risk_tier` is the frozen
 * `RiskTierEnum` (low | medium | high), imported NOT redefined. The legacy
 * routine/feature/security classifier and the separate review-depth axis are
 * DELETED: this schema rejects those legacy values and any `review_*` field.
 *
 * Loud-fail: `parseSpecTasks` / `parseSpecManifest` throw a ZodError on a missing
 * field, an out-of-enum risk tier, or a legacy axis — never silently coerce.
 */
import { z } from "zod";
import { RiskTierEnum } from "../types/index.js";

/**
 * One durable spec task. The `.strict()` shape is load-bearing: it makes a
 * resurrected legacy field (`review_depth`, `review_rounds`, a second classifier)
 * a LOUD parse error rather than a silently-ignored extra key — the deleted
 * second axis can never sneak back in through an unknown property.
 */
export const SpecTaskSchema = z
  .object({
    /** Stable task id within the spec (charset enforced by the consumer). */
    task_id: z.string().min(1),
    /** Short human title. */
    title: z.string().min(1),
    /** What the task delivers. */
    description: z.string().min(1),
    /**
     * The files this task touches — 1..3 (the ≤3-files granularity invariant the
     * spec reviewer also enforces). Empty or >3 is a loud parse error.
     */
    files: z.array(z.string().min(1)).min(1).max(3),
    /** ≥1 acceptance criterion; each must be testable (gate enforces non-vagueness). */
    acceptance_criteria: z.array(z.string().min(1)).min(1),
    /** Concrete test descriptions to write first (TDD). ≥1. */
    tests_to_write: z.array(z.string().min(1)).min(1),
    /** Task ids this task depends on (may be empty for a root task). */
    depends_on: z.array(z.string().min(1)).default([]),
    /**
     * The SINGLE producer dial (Decision 25) — the generator's whole-PRD
     * difficulty×stakes judgment. Imported from the frozen seam; the legacy
     * routine/feature/security values parse-fail here.
     */
    risk_tier: RiskTierEnum,
    /** Why this tier — required so the dial is a judgment, not a coin flip. */
    risk_rationale: z.string().min(1),
    /** Per-task TDD opt-out (read from the spec, never from runtime state). */
    tdd_exempt: z.boolean().optional(),
  })
  .strict();

export type SpecTask = z.infer<typeof SpecTaskSchema>;

/** A bare array of durable spec tasks — the canonical `tasks.json` on-disk form. */
export const SpecTasksSchema = z.array(SpecTaskSchema).min(1);

/**
 * The durable spec request. Mirrors the on-disk pairing of `spec.md` (free-form
 * markdown, stored separately) with the structured `tasks.json`. `spec_id =
 * "<issue>-<slug>"` (Δ X) — `issue_number` is the stable rerun lookup key.
 */
export const SpecManifestSchema = z
  .object({
    spec_id: z.string().min(1),
    issue_number: z.number().int().positive(),
    slug: z.string().min(1),
    /** Repo identity, e.g. "owner/name" (sanitized to a path segment by the store). */
    repo: z.string().min(1),
    /** ISO-8601 creation timestamp. */
    generated_at: z.string().min(1),
    tasks: SpecTasksSchema,
  })
  .strict();

export type SpecManifest = z.infer<typeof SpecManifestSchema>;

/**
 * Parse a bare `tasks.json` array into validated {@link SpecTask}s. LOUD on a
 * missing field, a bad/legacy risk tier, or any unknown (legacy-axis) property.
 */
export function parseSpecTasks(raw: unknown): SpecTask[] {
  return SpecTasksSchema.parse(raw);
}

/** Parse a {@link SpecManifest}. LOUD on any violation (same discipline). */
export function parseSpecManifest(raw: unknown): SpecManifest {
  return SpecManifestSchema.parse(raw);
}
