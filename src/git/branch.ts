/**
 * WS3 — run-scoped branch naming (Δ M).
 *
 * The bash pipeline used GLOBAL branch names (`task/<id>`, `factory/<issue>/<slug>`)
 * that COLLIDE when two concurrent runs touch the same task/issue. Δ M makes
 * every task branch run-scoped: `<prefix>/<run_id>/<task_id>` (default prefix
 * `factory`). Both id segments are validated via the shared `validateId` so a bad
 * id is a LOUD error here, not a malformed git ref that fails opaquely later.
 */
import { validateId } from "../shared/index.js";
import { GitSchema } from "../config/schema.js";

/** Default branch prefix from the config seam (single source of the literal). */
const DEFAULT_PREFIX = GitSchema.parse({}).branchPrefix;

/** Parsed segments of a run-scoped branch. */
export interface RunScopedBranchParts {
  prefix: string;
  runId: string;
  taskId: string;
}

/**
 * Build the run-scoped branch `<prefix>/<run_id>/<task_id>` (Δ M). Throws if
 * either id segment is not a valid identifier (no malformed ref escapes).
 */
export function runScopedBranch(
  runId: string,
  taskId: string,
  prefix: string = DEFAULT_PREFIX,
): string {
  validateId(runId, "run-id");
  validateId(taskId, "task-id");
  // The prefix is config-controlled, not user task input; still reject a slash
  // so the 3-segment shape stays unambiguous for the parser.
  if (prefix.length === 0 || prefix.includes("/")) {
    throw new Error(`branch: invalid prefix '${prefix}' (non-empty, no '/')`);
  }
  return `${prefix}/${runId}/${taskId}`;
}

/**
 * Predicate: does `ref` look like a run-scoped branch with the given prefix?
 * Validates the id segments too (a prefix match with junk segments is NOT a
 * run-scoped branch).
 */
export function isRunScopedBranch(ref: string, prefix: string = DEFAULT_PREFIX): boolean {
  return parseRunScopedBranch(ref, prefix) !== null;
}

/**
 * Parse a run-scoped branch back into its parts, or null if `ref` is not one.
 * Used by resume / cleanup to recover (runId, taskId) from an existing branch.
 * Returns null (not a throw) so callers can probe arbitrary refs; the segments,
 * when present, are guaranteed valid ids.
 */
export function parseRunScopedBranch(
  ref: string,
  prefix: string = DEFAULT_PREFIX,
): RunScopedBranchParts | null {
  const head = `${prefix}/`;
  if (!ref.startsWith(head)) return null;
  const rest = ref.slice(head.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const runId = rest.slice(0, slash);
  const taskId = rest.slice(slash + 1);
  // Both segments must be valid ids and the task segment must itself be a single
  // id (no further slashes) — otherwise it is not a well-formed run-scoped ref.
  if (taskId.length === 0 || taskId.includes("/")) return null;
  if (!isValidIdSafe(runId) || !isValidIdSafe(taskId)) return null;
  return { prefix, runId, taskId };
}

/** Local non-throwing id check (validateId throws; here null is the answer). */
function isValidIdSafe(id: string): boolean {
  try {
    validateId(id);
    return true;
  } catch {
    return false;
  }
}
