/**
 * WS5 — top-level spec-pipeline orchestration: resolve-or-generate.
 *
 * Flow (Δ G,H,I,J,X / D21,D23,D25):
 *   1. SpecStore.resolveByIssue → on a hit, RETURN its pointer (reuse, NO regen;
 *      the generate/review agents are never invoked) — Δ X.
 *   2. else GhClient.fetchPrd → SpecAgentRunner.generate (Opus/Max, D21) →
 *      parseSpecTasks → deterministic gates (gates.ts) → SpecAgentRunner.review
 *      (Opus/Max, D21) → decideSpecReview (56/60 + floor, Δ I).
 *   3. on NEEDS_REVISION (gates OR review) loop, bounded by maxRegenIterations;
 *      exhausting the cap throws a LOUD spec-defect (never spins).
 *   4. on PASS → SpecStore.write → return the {@link SpecPointer}.
 *
 * Every seam (GhClient / SpecAgentRunner / SpecStore) is injected, so this is
 * fully unit-testable with fakes — no real `gh`, LLM, or filesystem required for
 * the orchestration logic.
 */
import { nowIso } from "../shared/time.js";
import { createLogger } from "../shared/logging.js";
import type { SpecPointer } from "../types/index.js";
import { SPEC_DEFAULTS } from "../config/index.js";
import type { GhClient } from "./gh.js";
import {
  buildGenerateSpawn,
  buildReviewSpawn,
  type GenerateResult,
  type SpecAgentRunner,
} from "./agents.js";
import { runSpecGates, type GateResult } from "./gates.js";
import { decideSpecReview, type DecideOptions } from "./review.js";
import { parseSpecManifest, type SpecManifest } from "./schema.js";
import { makeSpecId, SpecStore } from "./store.js";

const log = createLogger("spec:pipeline");

/** Inputs for {@link runSpecPipeline}. */
export interface RunSpecPipelineOpts {
  repo: string;
  issueNumber: number;
  gh: GhClient;
  runner: SpecAgentRunner;
  store: SpecStore;
  /** Override the bounded revision cap (defaults to SPEC_DEFAULTS.maxRegenIterations). */
  maxRegenIterations?: number;
  /** Threshold/floor overrides forwarded to decideSpecReview. */
  decide?: DecideOptions;
}

/** Thrown when the bounded revision loop is exhausted without a passing spec. */
export class SpecDefectError extends Error {
  readonly issueNumber: number;
  readonly attempts: number;
  readonly blockers: string[];
  constructor(issueNumber: number, attempts: number, blockers: string[]) {
    super(
      `spec-defect: issue #${issueNumber} did not pass after ${attempts} attempt(s); ` +
        `outstanding blockers: ${blockers.join("; ")}`,
    );
    this.name = "SpecDefectError";
    this.issueNumber = issueNumber;
    this.attempts = attempts;
    this.blockers = blockers;
  }
}

/**
 * Resolve an existing spec by issue number, or generate+review+store a new one.
 * Returns the run-facing {@link SpecPointer} (the run records the pointer, never
 * the spec — Δ X).
 */
export async function runSpecPipeline(opts: RunSpecPipelineOpts): Promise<SpecPointer> {
  const { repo, issueNumber, gh, runner, store } = opts;
  const maxIterations = opts.maxRegenIterations ?? SPEC_DEFAULTS.maxRegenIterations;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`runSpecPipeline: maxRegenIterations must be >= 1, got ${maxIterations}`);
  }

  // (1) Δ X reuse — resolve by the STABLE issue number; on a hit, never regen.
  const existing = await store.resolveByIssue(repo, issueNumber);
  if (existing) {
    log.info(`reusing existing spec ${existing.spec_id} for issue #${issueNumber} (no regen)`);
    return store.toPointer(existing);
  }

  // (2) Generate + gate + review, bounded.
  const prd = await gh.fetchPrd(issueNumber, { repo });

  let lastBlockers: string[] = [];
  for (let attempt = 1; attempt <= maxIterations; attempt++) {
    const generated = await runner.generate(prd, buildGenerateSpawn(prd));

    // Deterministic structural gates first (cheaper than the LLM review).
    const gates: GateResult = runSpecGates(prd, generated.tasks);
    if (!gates.passed) {
      lastBlockers = gates.blockers;
      log.warn(
        `spec gates blocked issue #${issueNumber} (attempt ${attempt}/${maxIterations}): ` +
          gates.blockers.join("; "),
      );
      continue;
    }

    // LLM review (apex-pinned) + adjudication (56/60 + floor).
    const verdict = await runner.review(prd, generated, buildReviewSpawn(prd, generated));
    const decision = decideSpecReview(verdict, opts.decide);
    if (decision.decision === "NEEDS_REVISION") {
      lastBlockers = verdict.blockers.length > 0 ? verdict.blockers : [decision.reason];
      log.warn(
        `spec review NEEDS_REVISION for issue #${issueNumber} ` +
          `(attempt ${attempt}/${maxIterations}): ${decision.reason}`,
      );
      continue;
    }

    // (4) PASS — persist and return the pointer.
    const manifest = buildManifest(repo, issueNumber, generated);
    return store.write(manifest, generated.specMd);
  }

  // (3) Bounded loop exhausted — loud spec-defect, never spin.
  throw new SpecDefectError(issueNumber, maxIterations, lastBlockers);
}

/**
 * Build the durable manifest from a passing generate result. Exported so the
 * `factory spec store` CLI seam produces a manifest IDENTICALLY to the in-process
 * pipeline (one source of truth for slug re-derivation + spec-id construction).
 */
export function buildManifest(
  repo: string,
  issueNumber: number,
  generated: GenerateResult,
): SpecManifest {
  const specId = makeSpecId(issueNumber, generated.slug);
  // Re-derive the canonical slug from the spec_id so the manifest slug always
  // matches the path segment (the generator's raw slug is sanitized by makeSpecId).
  const slug = specId.replace(/^\d+-/, "");
  return parseSpecManifest({
    spec_id: specId,
    issue_number: issueNumber,
    slug,
    repo,
    generated_at: nowIso(),
    tasks: generated.tasks,
  });
}
