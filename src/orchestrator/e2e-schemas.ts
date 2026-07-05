/**
 * The e2e coroutine's OUTPUT contracts (Decision 39/40): the author's `--results`
 * envelope and the adjudicator's per-spec verdict. Split out of `e2e.ts` as a leaf
 * (no dependency on the coroutine core) so the schema surface is readable on its own;
 * `e2e.ts` re-exports the public names so importers are unchanged.
 */
import {z} from 'zod'
import {E2eManifestEntrySchema} from './deps.js'

/** Title prefix marking a spec's CONTROL assertion (fail-first-proof discipline). */
export const CONTROL_TITLE_PREFIX = 'control:'

/** One adjudicator ruling on a pre-existing failing spec (Decision 40 D7). */
export const E2eAdjudicationVerdictSchema = z
    .object({
        spec_path: z.string().min(1),
        verdict: z.enum(['regression', 'intentional-change']),
        /** Plain-language explanation — surfaced verbatim on a regression fail. */
        reason: z.string().min(1),
        /**
         * The authorizing task/spec language quoted verbatim. REQUIRED on every
         * intentional-change verdict — enforced at record (retry), not here, so a
         * missing citation reads as an incomplete response rather than a parse crash.
         */
        citation: z.string().optional(),
    })
    .strict()
export type E2eAdjudicationVerdict = z.infer<typeof E2eAdjudicationVerdictSchema>

export const E2eResultsSchema = z
    .object({
        status: z.string().min(1),
        /** Empty when the author judged no task in this run to be UI-facing. */
        manifest: z.array(E2eManifestEntrySchema).default([]),
        /**
         * Explicit "nothing UI-facing" signal — must be `true` whenever `manifest` is
         * empty. Distinguishes a genuine no-op from a malformed/incomplete author
         * response that the `manifest` field's own `.default([])` would otherwise
         * silently paper over as an unremarkable green. Omitted/false + an empty
         * manifest is treated as ambiguous, not a silent pass.
         */
        no_ui_surface: z.boolean().optional(),
        /**
         * The adjudication-results leg's payload (D7) — populated only when an
         * adjudication cursor is in flight (the cursor's presence in run state, not
         * any field here, is what routes the record; author results omit it).
         */
        verdicts: z.array(E2eAdjudicationVerdictSchema).optional(),
    })
    .strict()
// Named distinctly from `verifier/e2e`'s `E2eResults` (the Playwright run outcome,
// reachable via the same `./deps.js` barrel) — this is the author's `--results` envelope.
export type E2eAuthorResults = z.infer<typeof E2eResultsSchema>
