/**
 * WS5 — the spec-agent boundary (generate + review).
 *
 * Decision 21 (apex gate): the spec generator AND the spec reviewer are spawned
 * UNCONDITIONALLY at the apex model + effort. {@link buildGenerateSpawn} /
 * {@link buildReviewSpawn} hard-code that pin as local consts; they do NOT read
 * it from a risk tier, task count, or any config — the pin is invariant by
 * construction. WS5 owns spawn-request CONSTRUCTION + verdict parsing; the
 * WS10 in-session runner performs the live `Agent()` spawn (an agent cannot
 * deterministically spawn an agent inside a unit), mirroring how WS2 handlers
 * report and the runner acts.
 *
 * The {@link SpecAgentRunner} interface lets the pipeline unit test with fakes —
 * no real LLM spawn.
 */
import {z} from 'zod'
import type {Prd} from './gh.js'
import {SpecTasksSchema, type SpecTask} from './schema.js'
import type {ReviewVerdict} from './review.js'
import {SPEC_GENERATOR_AGENT_TYPE, SPEC_REVIEWER_AGENT_TYPE} from '../core/phase-machine/index.js'

/** Decision-21 apex pin — invariant by construction, deliberately NOT config. */
const APEX_MODEL = 'opus'
const APEX_EFFORT = 'max'

/** The two spec-agent roles. */
export type SpecAgentRole = 'spec-generator' | 'spec-reviewer'

/** PRD context every generator spawn carries (fresh generate AND revise). */
export interface GenerateContext {
    issue_number: number
    title: string
    body: string
    labels: string[]
}

/**
 * Revise-round context: the PRD fields PLUS the prior spec + blockers the
 * generator must patch (not re-derive). The three added keys are REQUIRED, so a
 * dropped or mistyped key is a compile error at the builder — that is the whole
 * point: it closes the regression where a PRD-only re-spawn re-authored the spec
 * from scratch and dropped previously-satisfied requirements.
 */
export interface ReviseContext extends GenerateContext {
    prior_spec_md: string
    prior_tasks: SpecTask[]
    review_feedback: readonly string[]
}

/** Reviewer spawn context: the PRD + the generated spec under review. */
export interface ReviewContext {
    issue_number: number
    prd_body: string
    spec_md: string
    tasks: SpecTask[]
}

/**
 * A spawn spec the WS10 runner consumes to launch the agent. `model` and
 * `effort` are the Decision-21 apex pin and are constants here.
 *
 * `context` is generic so each builder pins its exact shape ({@link GenerateContext} /
 * {@link ReviseContext} / {@link ReviewContext}); it defaults to
 * `Record<string, unknown>` so the envelope + {@link SpecAgentRunner} that hold a
 * spawn opaquely need no type churn. NOTE the static guarantee reaches the builders
 * and their tests ONLY — `context` is serialized to JSON and read by the markdown
 * agent by string key, the same boundary every prompt context crosses.
 */
export interface SpecSpawnSpec<C = Record<string, unknown>> {
    role: SpecAgentRole
    /** The runner-facing `Task(subagent_type)` value, spawned verbatim (C4). */
    agent_type: string
    /** Apex pin (Decision 21) — always {@link APEX_MODEL}. */
    model: string
    /** Apex pin (Decision 21) — always {@link APEX_EFFORT}. */
    effort: string
    /** Structured context handed to the agent prompt. */
    context: C
}

/** Result of a generate pass: the markdown + the structured task list. */
export interface GenerateResult {
    specMd: string
    /** Proposed slug for the spec (named by the generator at creation). */
    slug: string
    tasks: SpecTask[]
}

/**
 * Strict schema for a generator's {@link GenerateResult}. The generator is the
 * UNTRUSTED agent boundary, so its output is parsed LOUDLY here (the same
 * discipline as {@link import("./review.js").parseReviewVerdict} for the reviewer):
 * `tasks` flows through the `.strict()` {@link SpecTasksSchema}, so a missing
 * field, a bad/legacy risk tier, or a resurrected second-axis property is a parse
 * error — never a silently-coerced spec.
 */
export const GenerateResultSchema = z
    .object({
        specMd: z.string().min(1),
        slug: z.string().min(1),
        tasks: SpecTasksSchema,
    })
    .strict()

/** Parse raw generator output into a validated {@link GenerateResult}. LOUD on any violation. */
export function parseGenerateResult(raw: unknown): GenerateResult {
    return GenerateResultSchema.parse(raw)
}

/**
 * The injectable spec-agent boundary. The real implementation (WS10) drives a
 * live `Agent()` spawn from the spawn specs this module builds; units inject a
 * fake.
 */
export interface SpecAgentRunner {
    /** Generate spec.md + tasks for a PRD (apex-pinned). */
    generate(prd: Prd, spawn: SpecSpawnSpec): Promise<GenerateResult>
    /**
     * Review a generated spec against its PRD (apex-pinned). Returns the parsed
     * 6-dimension verdict (the runner is responsible for parsing the agent's raw
     * verdict block via {@link parseReviewVerdict}).
     */
    review(prd: Prd, generated: GenerateResult, spawn: SpecSpawnSpec): Promise<ReviewVerdict>
}

/** Build the apex-pinned spawn spec for the spec GENERATOR (Decision 21). */
export function buildGenerateSpawn(prd: Prd): SpecSpawnSpec<GenerateContext> {
    return {
        role: 'spec-generator',
        agent_type: SPEC_GENERATOR_AGENT_TYPE,
        model: APEX_MODEL,
        effort: APEX_EFFORT,
        context: {
            issue_number: prd.issue_number,
            title: prd.title,
            body: prd.body,
            labels: prd.labels,
        },
    }
}

/**
 * Build the apex-pinned RE-spawn for a revise round. Unlike a fresh generate, this
 * carries the PRIOR spec (`prior_spec_md` + `prior_tasks`) and the `review_feedback`
 * blockers to clear, so the generator PATCHES the spec already on disk instead of
 * re-deriving it from the PRD (a fresh context with PRD-only would regress
 * previously-satisfied requirements). Inherits the PRD context + Decision-21 pin from
 * {@link buildGenerateSpawn}; role stays `spec-generator`.
 */
export function buildReviseSpawn(
    prd: Prd,
    prior: GenerateResult,
    feedback: readonly string[]
): SpecSpawnSpec<ReviseContext> {
    const base = buildGenerateSpawn(prd)
    return {
        ...base,
        context: {
            ...base.context,
            prior_spec_md: prior.specMd,
            prior_tasks: prior.tasks,
            review_feedback: feedback,
        },
    }
}

/** Build the apex-pinned spawn spec for the spec REVIEWER (Decision 21). */
export function buildReviewSpawn(prd: Prd, generated: GenerateResult): SpecSpawnSpec<ReviewContext> {
    return {
        role: 'spec-reviewer',
        agent_type: SPEC_REVIEWER_AGENT_TYPE,
        model: APEX_MODEL,
        effort: APEX_EFFORT,
        context: {
            issue_number: prd.issue_number,
            prd_body: prd.body,
            spec_md: generated.specMd,
            tasks: generated.tasks,
        },
    }
}
