/**
 * WS10 — per-task worktree path derivation.
 *
 * A task worktree lives at `<dataDir>/worktrees/<run_id>/<task_id>` — a SIBLING of
 * the TCB-write-denied `runs/` and `specs/` trees (src/hooks/tcb.ts), so the
 * implementer CAN write inside its worktree while the run/spec stores stay immutable
 * to it. Both id segments are validated via the shared `validateId` so a bad id is
 * a LOUD error here, not a malformed filesystem path that fails opaquely later
 * (mirrors the run-scoped branch discipline in src/git/branch.ts).
 */
import { join } from "node:path";
import { validateId } from "../shared/index.js";
import { worktreesRoot } from "../core/state/index.js";

/**
 * The absolute worktree path for one task in one run. Deterministic — the
 * preflight reporter creates it and the verify/ship loop steps recompute it
 * (no need to thread it through state).
 */
export function taskWorktreePath(dataDir: string, runId: string, taskId: string): string {
  validateId(runId, "run-id");
  validateId(taskId, "task-id");
  return join(worktreesRoot(dataDir), runId, taskId);
}
