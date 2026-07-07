/**
 * WS2 — {@link SpawnRequest} Zod schema: the structured spawn payload the engine
 * hands the orchestrator when a phase needs subagents.
 *
 * Pure validation; NO I/O. This is the structured replacement for the
 * bash `_emit_manifest` JSON (`bin/pipeline-run-task-phases.sh`, exit-10 stdout).
 * Field renames from that shape (detail-only reference, never ported verbatim):
 *   - `subagent_type` → `role`
 *   - `prompt_file`   → `prompt_ref` (a run-store-relative pointer, not a path)
 *   - `maxTurns`      → `max_turns`
 *   - the `action:"spawn_agents"` tag is DROPPED — the `PhaseResult.kind`
 *     (`"spawn-agents"`) carries that now (result.ts).
 *
 * Validated as Zod so the v2 orchestrator consumes it as STRUCTURED OUTPUT: no exit
 * codes, no reading state.json for control flow. {@link parseSpawnRequest} is the
 * LOUD validating entry (mirrors WS1 `parseRunState`).
 */
import {z} from 'zod'
import {TaskPhaseEnum} from './phases.js'
import {EffortEnum} from '../../config/schema.js'

/**
 * The reviewer/producer roles the engine may ask the orchestrator to spawn. CLOSED set:
 * a role outside it is a loud parse error. Producers (`test-writer`/`implementer`)
 * plus the four-lens verifier panel (Decision 26/27/43: implementation-reviewer,
 * quality-reviewer — the merged adversarial quality+security+architecture+type-design
 * lens — silent-failure-hunter, systemic-failure-reviewer), the content-conditional
 * `database-design-reviewer` specialist (Decision 51: appended to the panel only when
 * the task diff touches migration/schema files), plus the run-level `scribe`.
 */
export const SpawnRoleEnum = z.enum([
    'test-writer',
    'implementer',
    'implementation-reviewer',
    'quality-reviewer',
    'silent-failure-hunter',
    'systemic-failure-reviewer',
    'database-design-reviewer',
    'scribe',
])
export type SpawnRole = z.infer<typeof SpawnRoleEnum>

/**
 * The SINGLE mapping home from engine role to the runner's `Task(subagent_type)`
 * value (C4/Decision 52): every spawn envelope carries `agent_type` so the runner
 * spawns it VERBATIM — no prose matrix to re-derive from. Bare plugin-local names
 * (`implementer`, not `factory:implementer`): same-plugin resolution wins.
 */
export const AGENT_TYPE_BY_ROLE = {
    'test-writer': 'test-writer',
    implementer: 'implementer',
    'implementation-reviewer': 'implementation-reviewer',
    'quality-reviewer': 'quality-reviewer',
    'silent-failure-hunter': 'silent-failure-hunter',
    'systemic-failure-reviewer': 'systemic-failure-reviewer',
    'database-design-reviewer': 'database-design-reviewer',
    scribe: 'scribe',
} as const satisfies Record<SpawnRole, string>

/** Holdout-validator sidecar + finding-verifier — generic contexts, no bespoke agent. */
export const GENERAL_PURPOSE_AGENT_TYPE = 'general-purpose'
/** The e2e AUTHOR and ADJUDICATOR spawns (both `expects` arms) share one agent. */
export const E2E_AUTHOR_AGENT_TYPE = 'e2e-author'
export const E2E_ASSESSOR_AGENT_TYPE = 'e2e-assessor'
export const TRACEABILITY_AUDITOR_AGENT_TYPE = 'traceability-auditor'
export const SPEC_GENERATOR_AGENT_TYPE = 'spec-generator'
export const SPEC_REVIEWER_AGENT_TYPE = 'spec-reviewer'

/**
 * One agent to spawn. `isolation` defaults to `"worktree"` (the normal case — the
 * subagent gets its own worktree branched off staging HEAD per the worktree
 * invariant); `"none"` reuses the caller's tree (offline/test paths).
 */
export const AgentSpecSchema = z.object({
    /** The reviewer/producer role (closed set). */
    role: SpawnRoleEnum,
    /** The runner-facing `Task(subagent_type)` value, spawned verbatim (C4). */
    agent_type: z.string().min(1),
    /** Worktree isolation. Defaults to "worktree". */
    isolation: z.enum(['worktree', 'none']).default('worktree'),
    /** Model identifier to run the agent on (non-empty; WS8 resolves the value). */
    model: z.string().min(1),
    /** Hard turn budget for the agent (positive integer). */
    max_turns: z.number().int().positive(),
    /**
     * The composed agent prompt, spawned VERBATIM (3b(i)/(ii)). Producer specs
     * always set it (`handlers.ts` `producerSpawn`); panel reviewer specs omit it —
     * the runner still builds those prompts inline from `agents/<role>.md` +
     * `skills/review-protocol/SKILL.md` (unchanged).
     */
    prompt: z.string().min(1).optional(),
    /**
     * Optional effort/reasoning level to spawn at (the closed {@link EffortEnum}:
     * low|medium|high|xhigh|max). Omitted ⇒ inherit the spawn default. Set by the
     * producer dial's effort climb (`model-dial.ts`) on high escalation rungs.
     */
    effort: EffortEnum.optional(),
})
export type AgentSpec = z.infer<typeof AgentSpecSchema>

/**
 * The resolved cross-vendor slot stamped on a VERIFY panel manifest (S5/C).
 * `present` ⇒ the runner executes the quality-reviewer via `codex exec` with
 * `model`, spawning `prompt` VERBATIM (3b/ii — the engine composes the charter +
 * review-protocol contract + worktree/base pointer at spawn time; the runner
 * supplies only the invariant `codex exec` flags); `absent` ⇒ all-Claude panel,
 * and the runner echoes `reason` verbatim as `crossVendorAbsent` in its results
 * file. Absent from producer manifests.
 */
export const CrossVendorStampSchema = z.union([
    z.object({status: z.literal('present'), model: z.string().min(1), prompt: z.string().min(1)}),
    z.object({status: z.literal('absent'), reason: z.string().min(1)}),
])
export type CrossVendorStamp = z.infer<typeof CrossVendorStampSchema>

/**
 * The independent finding-verifier's spawn TEMPLATE (3b/iii), stamped on VERIFY
 * panel manifests only. A template, not a per-finding spec — the finding set is
 * only known after the panel returns, so `prompt_template` carries the fixed
 * framing with `{field}` placeholders for the whitelisted per-finding data; the
 * runner renders one INSTANCE per blocking+citable finding by substituting
 * EXACTLY `interpolate_fields` (never the finding's `description` — anti-
 * anchoring, the verifier must judge the bare claim, not the reviewer's
 * reasoning). `agent_type`/`model`/`isolation` replace the runner's old
 * hardcoded `general-purpose`/`opus`/`"worktree"` — the last spawn decision not
 * carried by an envelope, now closed.
 */
export const VerifierSpecSchema = z.object({
    agent_type: z.string().min(1),
    model: z.string().min(1),
    isolation: z.enum(['worktree', 'none']).default('worktree'),
    prompt_template: z.string().min(1),
    interpolate_fields: z.array(z.string().min(1)).min(1),
})
export type VerifierSpec = z.infer<typeof VerifierSpecSchema>

/**
 * The full request: the phase the engine RESUMES at once the listed agents have
 * returned, plus a non-empty list of agents to spawn (in parallel).
 */
export const SpawnRequestSchema = z.object({
    /** Engine resumes here after the agents return. A per-task phase. */
    resume_phase: TaskPhaseEnum,
    /** Agents to spawn; at least one (an empty request is a programming error). */
    agents: z.array(AgentSpecSchema).min(1),
    /** Cross-vendor resolution — verify panel manifests only (S5/C). */
    cross_vendor: CrossVendorStampSchema.optional(),
    /** Finding-verifier spawn template — verify panel manifests only (3b/iii). */
    verifier_spec: VerifierSpecSchema.optional(),
})
export type SpawnRequest = z.infer<typeof SpawnRequestSchema>

/**
 * Parse + validate an unknown value as a {@link SpawnRequest}. LOUD (ZodError) on
 * an unknown role, a bad `resume_phase`, an empty `agents` array, or any bad field.
 * Applies the `isolation` default. Mirrors WS1 `parseRunState` — the sanctioned
 * validating entry point.
 */
export function parseSpawnRequest(raw: unknown): SpawnRequest {
    return SpawnRequestSchema.parse(raw)
}
