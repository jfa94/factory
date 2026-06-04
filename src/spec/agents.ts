/**
 * WS5 — the spec-agent boundary (generate + review).
 *
 * Decision 21 (apex gate): the spec generator AND the spec reviewer are spawned
 * UNCONDITIONALLY at the apex model + effort. {@link buildGenerateSpawn} /
 * {@link buildReviewSpawn} hard-code that pin from {@link SPEC_DEFAULTS}; they do
 * NOT read it from a risk tier, task count, or any per-input config — the pin is
 * the whole point. WS5 owns spawn-manifest CONSTRUCTION + verdict parsing; the
 * WS10 in-session driver performs the live `Agent()` spawn (an agent cannot
 * deterministically spawn an agent inside a unit), mirroring how WS2 handlers
 * report and the driver acts.
 *
 * The {@link SpecAgentRunner} interface lets the pipeline unit test with fakes —
 * no real LLM spawn.
 */
import type { Prd } from "./gh.js";
import type { SpecTask } from "./schema.js";
import type { ReviewVerdict } from "./review.js";
import { SPEC_DEFAULTS } from "./config-defaults.js";

/** The two spec-agent roles. */
export type SpecAgentRole = "spec-generator" | "spec-reviewer";

/**
 * A spawn spec the WS10 driver consumes to launch the agent. `model` and
 * `effort` are the Decision-21 apex pin and are constants here.
 */
export interface SpecSpawnSpec {
  role: SpecAgentRole;
  /** Apex pin (Decision 21) — always `SPEC_DEFAULTS.specModel`. */
  model: string;
  /** Apex pin (Decision 21) — always `SPEC_DEFAULTS.specEffort`. */
  effort: string;
  /** Structured context handed to the agent prompt. */
  context: Record<string, unknown>;
}

/** Result of a generate pass: the markdown + the structured task list. */
export interface GenerateResult {
  specMd: string;
  /** Proposed slug for the spec (named by the generator at creation). */
  slug: string;
  tasks: SpecTask[];
}

/**
 * The injectable spec-agent boundary. The real implementation (WS10) drives a
 * live `Agent()` spawn from the spawn specs this module builds; units inject a
 * fake.
 */
export interface SpecAgentRunner {
  /** Generate spec.md + tasks for a PRD (apex-pinned). */
  generate(prd: Prd, spawn: SpecSpawnSpec): Promise<GenerateResult>;
  /**
   * Review a generated spec against its PRD (apex-pinned). Returns the parsed
   * 6-dimension verdict (the runner is responsible for parsing the agent's raw
   * verdict block via {@link parseReviewVerdict}).
   */
  review(prd: Prd, generated: GenerateResult, spawn: SpecSpawnSpec): Promise<ReviewVerdict>;
}

/** Build the apex-pinned spawn spec for the spec GENERATOR (Decision 21). */
export function buildGenerateSpawn(prd: Prd): SpecSpawnSpec {
  return {
    role: "spec-generator",
    model: SPEC_DEFAULTS.specModel,
    effort: SPEC_DEFAULTS.specEffort,
    context: {
      issue_number: prd.issue_number,
      title: prd.title,
      body: prd.body,
      labels: prd.labels,
    },
  };
}

/** Build the apex-pinned spawn spec for the spec REVIEWER (Decision 21). */
export function buildReviewSpawn(prd: Prd, generated: GenerateResult): SpecSpawnSpec {
  return {
    role: "spec-reviewer",
    model: SPEC_DEFAULTS.specModel,
    effort: SPEC_DEFAULTS.specEffort,
    context: {
      issue_number: prd.issue_number,
      prd_body: prd.body,
      spec_md: generated.specMd,
      tasks: generated.tasks,
    },
  };
}
