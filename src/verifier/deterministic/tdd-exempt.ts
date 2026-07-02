/**
 * WS6 — tdd_exempt resolution (Δ N). Read from tasks.json (BOTH the
 * `{tasks:[...]}` and the bare-array schemas) and package.json
 * `.factory.tddExempt` — NEVER from state.json. Ports task_tdd_exempt
 * (bin/pipeline-lib.sh:966) + case_e1_bare_array_tdd_exempt.
 *
 * The JSON inputs are injected as already-parsed values so this is a pure function
 * the unit vectors exercise without a filesystem. A {@link DefaultExemptReader}
 * reads the real files for production.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../shared/logging.js";

const log = createLogger("verifier:tdd-exempt");

/**
 * Decide tdd_exempt from the parsed tasks.json + package.json. PURE.
 *   - tasks.json may be `[{task_id, tdd_exempt}, ...]` OR `{tasks:[...]}` (case4/4b/e1).
 *   - a matching task with `tdd_exempt === true` ⇒ exempt.
 *   - else package.json `.factory.tddExempt === true` ⇒ globally exempt.
 *   - anything else ⇒ NOT exempt (the safe default; a missing/garbage file never
 *     accidentally exempts).
 */
export function isTddExempt(taskId: string, tasksJson: unknown, packageJson: unknown): boolean {
  const list = extractTaskList(tasksJson);
  for (const entry of list) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      (entry as { task_id?: unknown }).task_id === taskId &&
      (entry as { tdd_exempt?: unknown }).tdd_exempt === true
    ) {
      return true;
    }
  }
  if (
    typeof packageJson === "object" &&
    packageJson !== null &&
    typeof (packageJson as { factory?: unknown }).factory === "object" &&
    (packageJson as { factory?: { tddExempt?: unknown } }).factory?.tddExempt === true
  ) {
    return true;
  }
  return false;
}

/** Normalize tasks.json into a task array, supporting both schemas. */
function extractTaskList(tasksJson: unknown): readonly unknown[] {
  if (Array.isArray(tasksJson)) return tasksJson;
  if (
    typeof tasksJson === "object" &&
    tasksJson !== null &&
    Array.isArray((tasksJson as { tasks?: unknown }).tasks)
  ) {
    return (tasksJson as { tasks: unknown[] }).tasks;
  }
  return [];
}

/** Reads tdd_exempt from the real files. Injected so units stay filesystem-free. */
export interface ExemptReader {
  isExempt(taskId: string): Promise<boolean>;
}

/** Construction args for {@link DefaultExemptReader}. */
export interface DefaultExemptReaderArgs {
  /** Directory holding tasks.json (the spec dir). */
  readonly specDir: string;
  /** Repo root holding package.json (the worktree). */
  readonly worktree: string;
}

/** Default reader: loads tasks.json + package.json from disk, then delegates to the pure fn. */
export class DefaultExemptReader implements ExemptReader {
  constructor(private readonly args: DefaultExemptReaderArgs) {}

  async isExempt(taskId: string): Promise<boolean> {
    const tasksJson = await readJsonOrNull(path.join(this.args.specDir, "tasks.json"));
    const packageJson = await readJsonOrNull(path.join(this.args.worktree, "package.json"));
    return isTddExempt(taskId, tasksJson, packageJson);
  }
}

/**
 * Read + parse a JSON file, or null when unusable. Only genuine absence (ENOENT)
 * is silent — an EXISTING file that is unreadable or corrupt is logged loudly,
 * because the safe not-exempt default would otherwise mask a real tdd_exempt
 * opt-out (task suddenly gated again with no visible cause).
 */
async function readJsonOrNull(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`could not read '${file}': ${(err as Error).message} — treating as not exempt`);
    }
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.warn(`could not parse '${file}': ${(err as Error).message} — treating as not exempt`);
    return null;
  }
}
