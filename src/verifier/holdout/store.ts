/**
 * WS10 (holdout, Δ Y) — the ANSWER-KEY store.
 *
 * The withheld criteria (split.ts) are the answer key. They MUST live OUTSIDE the
 * implementer worktree, under `runs/<run_id>/holdouts/<task_id>.json`, because that
 * is exactly the subtree the WS9 holdout-guard read-confines and the TCB
 * write-denies (Δ Y). Persisting here is what gives those guards something real to
 * protect — without it the confinement guards an empty directory.
 *
 * Two impls mirror artifacts.ts: {@link InMemoryHoldoutStore} (units) and
 * {@link FsHoldoutStore} (the persisted path, so a later `factory next-action` process
 * resuming at the verify phase reads the same answer key the split wrote at the
 * exec phase).
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../../shared/atomic-write.js";
import { validateId } from "../../shared/index.js";
import { parseJson, stringifyJson } from "../../shared/json.js";
import { runDir } from "../../core/state/index.js";

/**
 * The persisted answer-key record (snake_case to match the run-store JSON
 * convention). `withheld_count === withheld_criteria.length` is enforced by
 * {@link parseHoldoutRecord}; `total_criteria` records the pre-split size for the
 * validator prompt + audit.
 */
export const HoldoutRecordSchema = z
  .object({
    task_id: z.string().min(1),
    withheld_criteria: z.array(z.string()),
    total_criteria: z.number().int().nonnegative(),
    withheld_count: z.number().int().nonnegative(),
  })
  .strict()
  .refine((r) => r.withheld_count === r.withheld_criteria.length, {
    message: "withheld_count must equal withheld_criteria.length",
  });

/** A persisted holdout answer-key record. */
export type HoldoutRecord = z.infer<typeof HoldoutRecordSchema>;

/** Parse + validate a holdout record (LOUD on a malformed/forged answer key). */
export function parseHoldoutRecord(raw: unknown, source?: string): HoldoutRecord {
  const result = HoldoutRecordSchema.safeParse(raw);
  if (!result.success) {
    const where = source ? ` (${source})` : "";
    throw new Error(`invalid holdout record${where}: ${result.error.message}`);
  }
  return result.data;
}

/** Build a {@link HoldoutRecord} from a task id + its withheld criteria. */
export function makeHoldoutRecord(
  taskId: string,
  withheld: readonly string[],
  totalCriteria: number,
): HoldoutRecord {
  return {
    task_id: taskId,
    withheld_criteria: [...withheld],
    total_criteria: totalCriteria,
    withheld_count: withheld.length,
  };
}

/**
 * Persist + retrieve the per-task answer key. `put` is idempotent (overwrites) so
 * re-running the split on a retried step is safe; `get` is LOUD if absent.
 */
export interface HoldoutStore {
  put(runId: string, record: HoldoutRecord): Promise<void>;
  get(runId: string, taskId: string): Promise<HoldoutRecord>;
  has(runId: string, taskId: string): Promise<boolean>;
}

/** In-memory store: the in-process loop + units. Keyed by `runId\0taskId`. */
export class InMemoryHoldoutStore implements HoldoutStore {
  private readonly records = new Map<string, HoldoutRecord>();

  private key(runId: string, taskId: string): string {
    return `${runId} ${taskId}`;
  }

  put(runId: string, record: HoldoutRecord): Promise<void> {
    this.records.set(this.key(runId, record.task_id), record);
    return Promise.resolve();
  }

  get(runId: string, taskId: string): Promise<HoldoutRecord> {
    const record = this.records.get(this.key(runId, taskId));
    if (record === undefined) {
      return Promise.reject(
        new Error(`InMemoryHoldoutStore: no holdout for task '${taskId}' in run '${runId}'`),
      );
    }
    return Promise.resolve(record);
  }

  has(runId: string, taskId: string): Promise<boolean> {
    return Promise.resolve(this.records.has(this.key(runId, taskId)));
  }
}

/**
 * Fs-backed store under `runs/<run_id>/holdouts/<task_id>.json` (the Δ Y confined
 * subtree). Atomic writes via the shared helper — never a torn answer key. The
 * task id is validated to a safe slug before it becomes a path segment.
 */
export class FsHoldoutStore implements HoldoutStore {
  constructor(private readonly dataDir: string) {}

  private path(runId: string, taskId: string): string {
    const safe = validateId(taskId, "task_id");
    return join(runDir(this.dataDir, runId), "holdouts", `${safe}.json`);
  }

  async put(runId: string, record: HoldoutRecord): Promise<void> {
    const path = this.path(runId, record.task_id);
    await mkdir(dirname(path), { recursive: true });
    await atomicWriteFile(path, stringifyJson(record));
  }

  async get(runId: string, taskId: string): Promise<HoldoutRecord> {
    const path = this.path(runId, taskId);
    const raw = await readFile(path, "utf8");
    return parseHoldoutRecord(parseJson(raw, path), path);
  }

  async has(runId: string, taskId: string): Promise<boolean> {
    try {
      await readFile(this.path(runId, taskId), "utf8");
      return true;
    } catch {
      return false;
    }
  }
}
