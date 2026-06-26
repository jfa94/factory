/**
 * WS2 — {@link SpawnRequest} Zod schema: the structured spawn payload the engine
 * hands the orchestrator when a phase needs subagents.
 *
 * Pure validation; NO I/O. This is the v2-Workflow-friendly replacement for the
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
import { z } from "zod";
import { TaskPhaseEnum } from "./phases.js";
import { EffortEnum } from "../../config/schema.js";

/**
 * The reviewer/producer roles the engine may ask the orchestrator to spawn. CLOSED set:
 * a role outside it is a loud parse error. Producers (`test-writer`/`implementer`)
 * plus the verifier panel (Decision 26/27: implementation + quality always; the
 * risk-tier fan-out adds architecture/security; the CCR-pattern reviewers
 * silent-failure-hunter/type-design-reviewer) plus the run-level `scribe`.
 */
export const SpawnRoleEnum = z.enum([
  "test-writer",
  "implementer",
  "implementation-reviewer",
  "quality-reviewer",
  "architecture-reviewer",
  "security-reviewer",
  "silent-failure-hunter",
  "type-design-reviewer",
  "systemic-failure-reviewer",
  "scribe",
]);
export type SpawnRole = z.infer<typeof SpawnRoleEnum>;

/**
 * One agent to spawn. `isolation` defaults to `"worktree"` (the normal case — the
 * subagent gets its own worktree branched off staging HEAD per the worktree
 * invariant); `"none"` reuses the caller's tree (offline/test paths).
 */
export const AgentSpecSchema = z.object({
  /** The reviewer/producer role (closed set). */
  role: SpawnRoleEnum,
  /** Worktree isolation. Defaults to "worktree". */
  isolation: z.enum(["worktree", "none"]).default("worktree"),
  /** Model identifier to run the agent on (non-empty; WS8 resolves the value). */
  model: z.string().min(1),
  /** Hard turn budget for the agent (positive integer). */
  max_turns: z.number().int().positive(),
  /** Pointer to the prompt artifact, run-store relative (non-empty). */
  prompt_ref: z.string().min(1),
  /**
   * Optional effort/reasoning level to spawn at (the closed {@link EffortEnum}:
   * low|medium|high|xhigh|max). Omitted ⇒ inherit the spawn default. Set by the
   * producer dial's effort climb (`model-dial.ts`) on high escalation rungs.
   */
  effort: EffortEnum.optional(),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/**
 * The full request: the phase the engine RESUMES at once the listed agents have
 * returned, plus a non-empty list of agents to spawn (in parallel).
 */
export const SpawnRequestSchema = z.object({
  /** Engine resumes here after the agents return. A per-task phase. */
  resume_phase: TaskPhaseEnum,
  /** Agents to spawn; at least one (an empty request is a programming error). */
  agents: z.array(AgentSpecSchema).min(1),
});
export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

/**
 * Parse + validate an unknown value as a {@link SpawnRequest}. LOUD (ZodError) on
 * an unknown role, a bad `resume_phase`, an empty `agents` array, or any bad field.
 * Applies the `isolation` default. Mirrors WS1 `parseRunState` — the sanctioned
 * validating entry point.
 */
export function parseSpawnRequest(raw: unknown): SpawnRequest {
  return SpawnRequestSchema.parse(raw);
}
