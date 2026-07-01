/**
 * Whole-scope review harness — adjudication half (Decision 39's `/factory:debug`
 * rebuild, Task 1).
 *
 * `/factory:debug` reuses the SAME risk-invariant judgment layer the per-task
 * merge gate uses — citation-verify (Δ K) → independent finding-verifier (D27) →
 * per-reviewer adjudication — but applied to a WHOLE-SCOPE diff instead of one
 * task's diff. This module composes the EXISTING judgment/record exports
 * UNCHANGED (`buildPanelManifest`, `runPanel`, `parseRawReview`,
 * `buildWorktreeSource`, `makeReplayRunnerFactory`); it reimplements none of
 * citation-verify, confirmation, or panel construction.
 *
 * Deliberately narrow surface: debug consumes ONLY `runPanel`'s
 * `result.adjudicated`. `result.mergeGate` and `result.result` are per-task-phase
 * -shaped (they assume a single task's deterministic gate + phase-advance
 * semantics) and are not meaningful for a whole-scope review, so this module
 * never reads or re-exports them. `gateEvidence: []` is passed to `runPanel`
 * because whole-scope review has no per-task deterministic gate evidence to
 * combine — note this makes `deriveAllGatesVerdict`'s deterministic half (and so
 * `mergeGate.passed`/`result.result`) UNCONDITIONALLY fail-closed (an empty
 * evidence set never passes, by `deriveAllGatesVerdict`'s "nothing ran is never a
 * pass" rule in `src/core/state/derive.ts`) — harmless here because this module
 * never reads either field, but a real trap for any future caller that decides to
 * start reading `result.mergeGate`/`result.result` off of this call.
 */
import { buildPanelManifest } from "../verifier/judgment/panel.js";
import { parseRawReview, type Finding } from "../verifier/judgment/finding.js";
import { runPanel, type AdjudicatedReviewer } from "../verifier/judgment/panel-run.js";
import {
  buildWorktreeSource,
  makeReplayRunnerFactory,
  type ReviewerVerifications,
} from "../orchestrator/record.js";
import type { SpawnRequest } from "../types/index.js";

/** The panel spawn manifest bundled with the whole-scope review's diff scope. */
export interface DebugReviewManifest {
  /** The panel {@link SpawnRequest} built by {@link buildPanelManifest}. */
  readonly manifest: SpawnRequest;
  /** The diff base (a git ref or the empty-tree SHA). */
  readonly base: string;
  /** The debug staging checkout path the reviewers run against. */
  readonly worktree: string;
  /** Cross-vendor availability, passed through from the caller's resolution (Δ U). */
  readonly codexAvailable: boolean;
}

/**
 * Build the whole-scope review's panel manifest. A thin wrapper: delegates ALL
 * validation to {@link buildPanelManifest} (via `parseSpawnRequest`) and bundles
 * the result with the debug-specific diff-scope fields. No new validation logic.
 */
export function buildReviewManifest(opts: {
  readonly resumePhase: SpawnRequest["resume_phase"];
  readonly model: string;
  readonly maxTurns: number;
  readonly base: string;
  readonly worktree: string;
  readonly codexAvailable: boolean;
}): DebugReviewManifest {
  const manifest = buildPanelManifest(opts.resumePhase, opts.model, opts.maxTurns);
  return {
    manifest,
    base: opts.base,
    worktree: opts.worktree,
    codexAvailable: opts.codexAvailable,
  };
}

/** Input to {@link adjudicateWholeScope}. */
export interface AdjudicateWholeScopeInput {
  /** Raw, untrusted reviewer JSON output — one entry per panel reviewer. */
  readonly reviews: readonly unknown[];
  /** Already-recorded independent finding-verifier verdicts, per reviewer. */
  readonly verifications: readonly ReviewerVerifications[];
  /** The worktree citation-verify reads cited files from. */
  readonly worktree: string;
  /** Δ U — a recorded second-vendor absence, threaded to the replay runner factory. */
  readonly crossVendorAbsent?: { readonly reason: string };
}

/** The result of adjudicating a whole-scope review. */
export interface AdjudicateWholeScopeResult {
  /** Per-reviewer adjudicated detail, passed through from `runPanel`. */
  readonly adjudicated: readonly AdjudicatedReviewer[];
  /** Every CONFIRMED blocking finding, flattened across all reviewers. */
  readonly confirmedBlockers: readonly Finding[];
  /** True iff no reviewer has a confirmed blocker. */
  readonly clean: boolean;
}

/**
 * Turn raw whole-scope reviewer output into a stop/continue decision.
 *
 * 1. `parseRawReview` each raw entry — LOUD (throws) on an unparseable review;
 *    never silently skipped.
 * 2. Build a {@link SourceReader} over `input.worktree` via `buildWorktreeSource`.
 * 3. Build the replay {@link FindingVerifierRunner} factory over the already-
 *    recorded verifier verdicts via `makeReplayRunnerFactory`.
 * 4. Run the judgment panel via `runPanel`, with `gateEvidence: []` (see module
 *    header) and `redact: true`.
 * 5. Flatten every reviewer's confirmed blockers into one array.
 *
 * Deliberately does NOT read or return `result.mergeGate`/`result.result` — see
 * module header.
 */
export async function adjudicateWholeScope(
  input: AdjudicateWholeScopeInput,
): Promise<AdjudicateWholeScopeResult> {
  const reviews = input.reviews.map(parseRawReview);
  const source = await buildWorktreeSource(input.worktree, reviews);
  const makeRunner = makeReplayRunnerFactory({
    reviews: input.reviews,
    verifications: input.verifications,
    ...(input.crossVendorAbsent !== undefined
      ? { crossVendorAbsent: input.crossVendorAbsent }
      : {}),
  });

  const result = await runPanel({
    reviews,
    source,
    makeRunner,
    gateEvidence: [],
    phase: "verify",
    redact: true,
  });

  const confirmedBlockers = result.adjudicated.flatMap((a) => a.confirmedBlockers);
  return {
    adjudicated: result.adjudicated,
    confirmedBlockers,
    clean: confirmedBlockers.length === 0,
  };
}
