/**
 * Per-task `tdd_exempt` reader wiring (Δ N).
 *
 * The deterministic TDD gate honors `tdd_exempt` ONLY when the GateContext carries
 * an {@link ExemptReader} (src/verifier/deterministic/strategies/tdd.ts:99). Both
 * live GateContext construction sites — the verify reporter
 * ({@link import("./handlers.js").makeStageHandlers}) and the record-reviews record
 * ({@link import("./record.js").applyRecordReviews}) — build the reader here so an
 * exempt task is recognized CONSISTENTLY by the gate.
 *
 * The reader resolves `tdd_exempt` from the durable spec's `tasks.json` (addressed
 * by the run's `{repo, spec_id}` pointer) + the worktree's `package.json` —
 * NEVER state.json (derive-don't-store). Without this wiring an exempt task whose
 * test-writer phase was skipped commits impl-only history, which the TDD gate would
 * otherwise classify as a violation and block forever.
 */
import { DefaultExemptReader, type ExemptReader } from "../verifier/deterministic/index.js";
import { specDir } from "../core/state/index.js";

/** The fields {@link taskExemptReader} needs from the reporter dep bundle. */
export interface ExemptReaderDeps {
  readonly dataDir: string;
  readonly spec: { readonly repo: string; readonly spec_id: string };
}

/**
 * Build the per-task {@link ExemptReader} for a GateContext: tasks.json from the
 * run's durable spec dir, package.json from the per-task `worktree`.
 */
export function taskExemptReader(deps: ExemptReaderDeps, worktree: string): ExemptReader {
  return new DefaultExemptReader({
    specDir: specDir(deps.dataDir, deps.spec.repo, deps.spec.spec_id),
    worktree,
  });
}
