/**
 * WS2 — {@link SpawnManifest} Zod schema: the structured spawn payload the engine
 * hands the driver when a stage needs subagents.
 *
 * Pure validation; NO I/O. This is the v2-Workflow-friendly replacement for the
 * bash `_emit_manifest` JSON (`bin/pipeline-run-task-stages.sh`, exit-10 stdout).
 * Field renames from that shape (detail-only reference, never ported verbatim):
 *   - `subagent_type` → `role`
 *   - `prompt_file`   → `prompt_ref` (a run-store-relative pointer, not a path)
 *   - `maxTurns`      → `max_turns`
 *   - the `action:"spawn_agents"` tag is DROPPED — the `StageResult.kind`
 *     (`"spawn-agents"`) carries that now (result.ts).
 *
 * Validated as Zod so the v2 driver consumes it as STRUCTURED OUTPUT: no exit
 * codes, no reading state.json for control flow. {@link parseSpawnManifest} is the
 * LOUD validating entry (mirrors WS1 `parseRunState`).
 */
import { z } from "zod";
import { TaskStageEnum } from "./stages.js";

/**
 * The reviewer/producer roles the engine may ask the driver to spawn. CLOSED set:
 * a role outside it is a loud parse error. Producers (`test-writer`/`executor`)
 * plus the verifier panel (Decision 26/27: implementation + quality always; the
 * risk-tier fan-out adds architecture/security; the CCR-pattern reviewers
 * silent-failure-hunter/type-design-reviewer) plus the run-level `scribe`.
 */
export const SpawnRoleEnum = z.enum([
  "test-writer",
  "executor",
  "implementation-reviewer",
  "quality-reviewer",
  "architecture-reviewer",
  "security-reviewer",
  "silent-failure-hunter",
  "type-design-reviewer",
  "scribe",
]);
export type SpawnRole = z.infer<typeof SpawnRoleEnum>;

/**
 * One agent to spawn. `isolation` defaults to `"worktree"` (the normal case — the
 * subagent gets its own worktree branched off staging HEAD per the worktree
 * invariant); `"none"` reuses the caller's tree (offline/test paths).
 */
export const SpawnAgentSchema = z.object({
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
   * Optional effort/reasoning level to spawn at (the `Agent` effort enum:
   * low|medium|high|xhigh|max). Omitted ⇒ inherit the spawn default. Set by the
   * producer dial's effort climb (`model-dial.ts`) on high escalation rungs.
   */
  effort: z.string().min(1).optional(),
});
export type SpawnAgent = z.infer<typeof SpawnAgentSchema>;

/**
 * The full manifest: the stage the engine RESUMES at once the listed agents have
 * returned, plus a non-empty list of agents to spawn (in parallel).
 */
export const SpawnManifestSchema = z.object({
  /** Engine resumes here after the agents return. A per-task stage. */
  stage_after: TaskStageEnum,
  /** Agents to spawn; at least one (an empty manifest is a programming error). */
  agents: z.array(SpawnAgentSchema).min(1),
});
export type SpawnManifest = z.infer<typeof SpawnManifestSchema>;

/**
 * Parse + validate an unknown value as a {@link SpawnManifest}. LOUD (ZodError) on
 * an unknown role, a bad `stage_after`, an empty `agents` array, or any bad field.
 * Applies the `isolation` default. Mirrors WS1 `parseRunState` — the sanctioned
 * validating entry point.
 */
export function parseSpawnManifest(raw: unknown): SpawnManifest {
  return SpawnManifestSchema.parse(raw);
}
