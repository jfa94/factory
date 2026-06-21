/**
 * WS5 — durable spec-manifest construction.
 *
 * The top-level resolve-or-generate orchestration (`runSpecPipeline`) was removed:
 * the live path is the 3-action `factory spec resolve|gate|store` CLI
 * (src/cli/subcommands/spec.ts), which the orchestrator drives agent-by-agent. What
 * remains is the ONE shared manifest builder the CLI `store` action (and any other
 * caller) uses, so spec-id + slug derivation has a single source of truth.
 */
import { nowIso } from "../shared/time.js";
import { parseSpecManifest, type SpecManifest } from "./schema.js";
import { makeSpecId } from "./store.js";
import type { GenerateResult } from "./agents.js";

/**
 * Build the durable manifest from a passing generate result. Exported so the
 * `factory spec store` CLI seam produces a manifest IDENTICALLY to any in-process
 * caller (one source of truth for slug re-derivation + spec-id construction).
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
