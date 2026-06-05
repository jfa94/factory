/**
 * WS6 — tree-SHA + tip-SHA memoization (Δ N/O).
 *
 * Two memo needs:
 *   - TDD result keyed on `taskId@tipSha` (Δ N): a re-run of the SAME task on the
 *     SAME tip returns the prior result without re-classifying — and on a SQUASHED
 *     history (a single squashed commit on staging) the gate is a NO-OP, so a
 *     memoized result is returned rather than re-running the classifier. The key
 *     includes the taskId because the TDD classification depends on it (the
 *     `[task-id]` commit tag drives the per-task ordering check), so two different
 *     tasks at the same tip must NOT share a memo entry.
 *   - per-strategy EVIDENCE keyed on the worktree TREE SHA (Δ O): a re-run on
 *     identical content is a no-op.
 *
 * DERIVE-DON'T-STORE GUARD (Δ V): the cache stores EVIDENCE / the TDD verdict
 * struct, NEVER a GateVerdict. A verdict is always re-derived from evidence by the
 * runner — a cache hit cannot bypass re-derivation, it only skips re-EXECUTING the
 * tool. In-memory + per-instance only (no run-dir persistence) to avoid a
 * stale-cache derive-don't-store smell across runs.
 */
import type { GateEvidence } from "../../types/index.js";
import type { GateId } from "./gate-id.js";
import type { TddVerdict } from "./tdd-classify.js";

/**
 * In-memory memo. Keyed by a content sha (tree or tip) so identical content yields
 * a cache hit. NOT persisted — lifetime is the cache instance.
 */
export class GateMemo {
  /** `${gate}@${treeSha}` → evidence (ground truth, never a verdict). */
  private readonly evidence = new Map<string, GateEvidence>();
  /** `${taskId}@${tipSha}` → the TDD verdict struct (re-derived by the runner). */
  private readonly tdd = new Map<string, TddVerdict>();

  private evKey(gate: GateId, treeSha: string): string {
    return `${gate}@${treeSha}`;
  }

  private tddKey(taskId: string, tipSha: string): string {
    return `${taskId}@${tipSha}`;
  }

  /** Look up cached evidence for a gate at a tree sha (undefined = miss). */
  getEvidence(gate: GateId, treeSha: string): GateEvidence | undefined {
    return this.evidence.get(this.evKey(gate, treeSha));
  }

  /** Cache a gate's evidence at a tree sha. */
  putEvidence(gate: GateId, treeSha: string, ev: GateEvidence): void {
    this.evidence.set(this.evKey(gate, treeSha), ev);
  }

  /** Look up the memoized TDD verdict for a task at a tip sha (undefined = miss). */
  getTdd(taskId: string, tipSha: string): TddVerdict | undefined {
    return this.tdd.get(this.tddKey(taskId, tipSha));
  }

  /** Memoize the TDD verdict for a task at a tip sha. */
  putTdd(taskId: string, tipSha: string, verdict: TddVerdict): void {
    this.tdd.set(this.tddKey(taskId, tipSha), verdict);
  }
}
