/**
 * WS12 — the run FINALIZE coordinator (§④ rollup + §⑤ outcome; Δ S).
 *
 * Exercises the resume-safe ordering + idempotency contract end-to-end against the
 * real {@link StateManager} (temp dir) + the exported {@link FakeGhClient}:
 *   - completed  → rollup merges (live) / opens-only (no-merge), 0 issues;
 *   - partial    → terminal partial, PARTIAL: rollup subject, one issue per drop;
 *   - failed     → no rollup (nothing shipped), one issue per drop;
 *   - resume     → a second finalize files 0 new issues + short-circuits the rollup;
 *   - anti-spin  → a non-terminal task makes finalize THROW (never advances).
 *
 * The report.md + metrics.jsonl side effects are asserted from disk (derive-don't-
 * store: the report is recomputed, never read back).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finalizeRun, type FinalizeRunDeps } from "./finalize.js";
import { StateManager } from "../core/state/manager.js";
import { FakeGhClient, FakeGitClient } from "../git/fakes.js";
import { parseSpecManifest, type SpecManifest } from "../spec/index.js";
import { readMetrics } from "../scoring/index.js";
import { runReportPath } from "../core/state/paths.js";
import { defaultConfig } from "../config/schema.js";
import type { ShipMode } from "./types.js";
import type { FailureClass, TaskState } from "../types/index.js";

const RUN_ID = "run-final-1";
const REPO = "acme/widgets";
const SPEC_ID = "42-checkout";
const ISSUE = 42;
const NOW = "2026-06-08T12:00:00.000Z";

/** A task partial for both the spec and the run-state seeding. */
interface TaskSeed {
  task_id: string;
  status: "done" | "dropped";
  failure_class?: FailureClass;
  failure_reason?: string;
  branch?: string;
  pr_number?: number;
  acceptance_criteria?: readonly string[];
}

/** Build a SpecManifest whose task ids/criteria match the run seeds. */
function makeSpec(tasks: readonly TaskSeed[]): SpecManifest {
  return parseSpecManifest({
    spec_id: SPEC_ID,
    issue_number: ISSUE,
    slug: "checkout",
    repo: REPO,
    generated_at: "2026-06-01T00:00:00.000Z",
    tasks: tasks.map((t) => ({
      task_id: t.task_id,
      title: `task ${t.task_id}`,
      description: `does ${t.task_id}`,
      files: [`src/${t.task_id}.ts`],
      acceptance_criteria: t.acceptance_criteria ?? ["a", "b", "c"],
      tests_to_write: ["covers it"],
      depends_on: [],
      risk_tier: "medium",
      risk_rationale: "moderate",
    })),
  });
}

/** Map a seed to a terminal TaskState row (carries the drop cross-fields). */
function taskRow(t: TaskSeed): TaskState {
  const base: TaskState = {
    task_id: t.task_id,
    status: t.status,
    depends_on: [],
    risk_tier: "medium",
    escalation_rung: 0,
    reviewers: [],
    merge_resyncs: 0,
    ...(t.branch !== undefined ? { branch: t.branch } : {}),
    ...(t.pr_number !== undefined ? { pr_number: t.pr_number } : {}),
  };
  if (t.status === "dropped") {
    return {
      ...base,
      failure_class: t.failure_class ?? "capability-budget",
      failure_reason: t.failure_reason ?? "ran out of retries",
    };
  }
  return base;
}

describe("finalizeRun", () => {
  let dataDir: string;
  let state: StateManager;
  let gh: FakeGhClient;
  let git: FakeGitClient;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-finalize-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    gh = new FakeGhClient();
    git = new FakeGitClient();
    await state.create({
      run_id: RUN_ID,
      spec: { repo: REPO, spec_id: SPEC_ID, issue_number: ISSUE },
    });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Seed the run's terminal task rows in one write. */
  async function seed(tasks: readonly TaskSeed[]): Promise<void> {
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: Object.fromEntries(tasks.map((t) => [t.task_id, taskRow(t)])),
    }));
  }

  /** Assemble the finalize deps (no-op sleep, tiny CI budget). */
  function makeDeps(spec: SpecManifest, shipMode: ShipMode): FinalizeRunDeps {
    return {
      state,
      gh,
      git,
      config: defaultConfig(),
      spec,
      dataDir,
      owner: "acme",
      repo: "widgets",
      shipMode,
      nowIso: NOW,
      rollup: { sleep: async () => {}, pollIntervalMs: 0, maxPolls: 3 },
    };
  }

  it("completed + live: merges the rollup with a plain subject, files no issues", async () => {
    const tasks: TaskSeed[] = [
      { task_id: "t1", status: "done", branch: "factory/run/t1", pr_number: 11 },
      { task_id: "t2", status: "done", pr_number: 12 },
    ];
    await seed(tasks);
    const spec = makeSpec(tasks);

    const result = await finalizeRun(makeDeps(spec, "live"), RUN_ID);

    expect(result.run.status).toBe("completed");
    expect(result.report.run_status).toBe("completed");
    expect(result.issuesFiled).toBe(0);
    expect(gh.issues).toHaveLength(0);
    // rollup merged with the plain title as subject (Decision 34: develop gets only complete runs).
    expect(result.rollup?.merged).toBe(true);
    expect(result.rollup?.subject).not.toMatch(/^PARTIAL:/);
    expect(gh.merges).toHaveLength(1);

    // persisted run is terminal.
    expect((await state.read(RUN_ID)).status).toBe("completed");
  });

  it("completed + no-merge: opens the rollup PR but never merges it", async () => {
    const tasks: TaskSeed[] = [{ task_id: "t1", status: "done", pr_number: 11 }];
    await seed(tasks);

    const result = await finalizeRun(makeDeps(makeSpec(tasks), "no-merge"), RUN_ID);

    expect(result.run.status).toBe("completed");
    expect(result.rollup?.merged).toBe(false);
    expect(result.rollup?.reason).toBe("no-merge");
    expect(gh.merges).toHaveLength(0);
    expect(gh.created).toHaveLength(1); // PR opened for inspection
  });

  it("failed (some dropped): no rollup, one issue per drop, PRD left open (Decision 34)", async () => {
    // Decision 34: develop receives only complete PRDs. A mixed done+dropped run is
    // 'failed', gets no rollup, and the PRD issue is left open.
    const tasks: TaskSeed[] = [
      { task_id: "t1", status: "done", pr_number: 11 },
      {
        task_id: "t2",
        status: "dropped",
        failure_class: "spec-defect",
        failure_reason: "criterion unattainable",
      },
    ];
    await seed(tasks);
    const spec = makeSpec(tasks);

    const result = await finalizeRun(makeDeps(spec, "live"), RUN_ID);

    expect(result.run.status).toBe("failed");
    expect(result.issuesFiled).toBe(1);
    expect(gh.issues).toHaveLength(1);
    // the issue carries the factory + per-class labels (the dedup + triage keys).
    expect(gh.issues[0]!.labels).toEqual(["factory", "factory:spec-defect"]);
    expect(gh.issues[0]!.title).toContain("t2");
    // Decision 34: no rollup on failed — develop is untouched.
    expect(result.rollup).toBeUndefined();
    expect(gh.merges).toHaveLength(0);
    // PRD issue NOT closed.
    expect(gh.issueCloses).toHaveLength(0);
  });

  it("failed (all dropped): no rollup, one issue per drop, run flips to failed", async () => {
    const tasks: TaskSeed[] = [
      { task_id: "t1", status: "dropped", failure_class: "capability-budget" },
      { task_id: "t2", status: "dropped", failure_class: "blocked-environmental" },
    ];
    await seed(tasks);

    const result = await finalizeRun(makeDeps(makeSpec(tasks), "live"), RUN_ID);

    expect(result.run.status).toBe("failed");
    expect(result.rollup).toBeUndefined(); // nothing shipped → no rollup attempted
    expect(gh.created).toHaveLength(0);
    expect(result.issuesFiled).toBe(2);
    expect(gh.issues).toHaveLength(2);
  });

  it("persists report.md and run.finalized + per-drop telemetry", async () => {
    const tasks: TaskSeed[] = [
      { task_id: "t1", status: "done", pr_number: 11 },
      { task_id: "t2", status: "dropped", failure_class: "spec-defect" },
    ];
    await seed(tasks);

    await finalizeRun(makeDeps(makeSpec(tasks), "live"), RUN_ID);

    const md = await readFile(runReportPath(dataDir, RUN_ID), "utf8");
    expect(md).toContain("# Factory run report");
    // Decision 34: mixed done+dropped is 'failed', not 'partial'.
    expect(md).toContain("Status:** FAILED");
    expect(md).toContain(NOW);

    const metrics = await readMetrics(dataDir, RUN_ID);
    const finalized = metrics.find((m) => m.event === "run.finalized");
    expect(finalized?.data?.status).toBe("failed");
    expect(metrics.filter((m) => m.event === "task.dropped")).toHaveLength(1);
  });

  it("resume-safe (failed): a second finalize on a failed run files 0 new issues and stays failed", async () => {
    // Decision 34: a failed run has no rollup to resume; idempotency means the
    // second finalize also files 0 new issues and leaves the run status as failed.
    const tasks: TaskSeed[] = [
      { task_id: "t1", status: "done", pr_number: 11 },
      { task_id: "t2", status: "dropped", failure_class: "spec-defect" },
    ];
    await seed(tasks);
    const spec = makeSpec(tasks);

    const first = await finalizeRun(makeDeps(spec, "live"), RUN_ID);
    expect(first.issuesFiled).toBe(1);
    expect(first.rollup).toBeUndefined(); // no rollup on failed

    // Re-enter finalize: idempotent across the board.
    const second = await finalizeRun(makeDeps(spec, "live"), RUN_ID);
    expect(second.issuesFiled).toBe(0); // deduped against the existing factory issue
    expect(gh.issues).toHaveLength(1); // no duplicate filed
    expect(second.rollup).toBeUndefined(); // still no rollup
    expect(gh.merges).toHaveLength(0); // never merged
    expect((await state.read(RUN_ID)).status).toBe("failed");
  });

  it("anti-spin: a non-terminal task makes finalize THROW (never advances)", async () => {
    // One done, one still executing → decideFinalize refuses (would otherwise spin).
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: {
        t1: taskRow({ task_id: "t1", status: "done", pr_number: 11 }),
        t2: {
          task_id: "t2",
          status: "executing",
          depends_on: [],
          risk_tier: "medium",
          escalation_rung: 0,
          reviewers: [],
          merge_resyncs: 0,
        },
      },
    }));
    const spec = makeSpec([
      { task_id: "t1", status: "done" },
      { task_id: "t2", status: "done" },
    ]);

    await expect(finalizeRun(makeDeps(spec, "live"), RUN_ID)).rejects.toThrow();
    // state untouched — still running, resumable.
    expect((await state.read(RUN_ID)).status).toBe("running");
  });

  it("completed: rolls up, comments + closes the PRD issue (Decision 34)", async () => {
    const tasks: TaskSeed[] = [
      { task_id: "t1", status: "done", branch: "factory/run/t1", pr_number: 11 },
      { task_id: "t2", status: "done", pr_number: 12 },
    ];
    await seed(tasks);
    const spec = makeSpec(tasks);

    await finalizeRun(makeDeps(spec, "live"), RUN_ID);

    // rollup merged
    expect(gh.merges).toHaveLength(1);
    // PRD comment filed with the issue number
    expect(gh.issueComments.map((c) => c.number)).toContain(ISSUE);
    // PRD closed
    expect(gh.issueCloses.map((c) => c.number)).toContain(ISSUE);
  });

  it("completed + no-merge: no merge, no PRD close (rollup opened only)", async () => {
    const tasks: TaskSeed[] = [{ task_id: "t1", status: "done", pr_number: 11 }];
    await seed(tasks);

    await finalizeRun(makeDeps(makeSpec(tasks), "no-merge"), RUN_ID);

    expect(gh.merges).toHaveLength(0);
    // PR opened but not merged → no PRD close/comment
    expect(gh.issueCloses).toHaveLength(0);
    expect(gh.issueComments).toHaveLength(0);
  });

  it("failed (some dropped): no rollup, PRD NOT closed (Decision 34)", async () => {
    const tasks: TaskSeed[] = [
      { task_id: "t1", status: "done", pr_number: 11 },
      { task_id: "t2", status: "dropped", failure_class: "capability-budget" },
    ];
    await seed(tasks);

    const res = await finalizeRun(makeDeps(makeSpec(tasks), "live"), RUN_ID);

    expect(res.run.status).toBe("failed");
    expect(gh.merges).toHaveLength(0);
    expect(gh.issueCloses).toHaveLength(0);
    expect(gh.issueComments).toHaveLength(0);
  });

  it("reconciles develop into staging/<run-id> then rolls up that branch", async () => {
    const tasks: TaskSeed[] = [
      { task_id: "t1", status: "done", pr_number: 11 },
      { task_id: "t2", status: "done", pr_number: 12 },
    ];
    await seed(tasks);
    const spec = makeSpec(tasks);

    const res = await finalizeRun(makeDeps(spec, "live"), RUN_ID);

    // (a) git merged origin/develop into staging/<run-id> before the rollup PR.
    expect(git.mergesInto[`staging/${RUN_ID}`]).toContain("origin/develop");
    // (b) the rollup PR head is staging/<run-id>.
    expect(gh.created.at(-1)?.head).toBe(`staging/${RUN_ID}`);
    // (c) run reached completed.
    expect(res.run.status).toBe("completed");
  });
});
