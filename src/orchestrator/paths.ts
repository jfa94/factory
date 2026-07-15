/**
 * WS10 — per-task worktree path derivation.
 *
 * A task worktree lives at `<workDir>/<run_id>/<task_id>` — `workDir` is
 * `<main-repo-root>/.claude/worktrees`, the one subtree Claude Code's
 * protected-path check exempts (Decision 67), NOT the plugin dataDir (which
 * roots only the TCB-write-denied `runs/`/`specs/` trees, src/hooks/tcb.ts).
 * Both id segments are validated via the shared `validateId` so a bad id is
 * a LOUD error here, not a malformed filesystem path that fails opaquely later
 * (mirrors the run-scoped branch discipline in src/git/branch.ts).
 */
import {join} from 'node:path'
import {validateId} from '../shared/index.js'

/**
 * The absolute worktree path for one task in one run. Deterministic — the
 * preflight reporter creates it and the verify/ship loop steps recompute it
 * (no need to thread it through state).
 */
export function taskWorktreePath(workDir: string, runId: string, taskId: string): string {
    validateId(runId, 'run-id')
    validateId(taskId, 'task-id')
    return join(workDir, runId, taskId)
}
