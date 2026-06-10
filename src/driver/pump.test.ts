/**
 * Unit tests for pumpTask — the per-task coroutine pump.
 *
 * Each test gets a FRESH tmp dataDir (no shared mutable state). makePumpDeps
 * seeds the run and task state and returns deps + run-id.
 *
 * Helpers:
 *   - driveToVerify: pump twice (fold DONE twice) to reach the verify spawn;
 *     returns the verify spawn envelope (LOUD if not reached)
 *   - approvingReviewsResults: a DriveResults with 6 approving reviews + holdout pass
 *   - blockingReviewsResults: a DriveResults with one confirmed blocker
 *
 * fold_key discipline: every helper that builds a DriveResults accepts the prior
 * spawn envelope and copies fold_key verbatim — the natural driver behavior.
 */
import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { pumpTask, MERGE_RESYNC_CAP, type DriveEnvelope } from "./pump.js";
import { TASK_STAGE_ORDER } from "../types/index.js";
import { TaskStateSchema } from "../core/state/index.js";
import type { DriveResults, FoldKey } from "./results.js";
import type { PumpDeps } from "./pump.js";

import { defaultConfig } from "../config/schema.js";
import { parseSpecManifest } from "../spec/schema.js";
import type { SpecManifest } from "../spec/index.js";
import { StateManager } from "../core/state/manager.js";
import { FakeGitClient, FakeGhClient } from "../git/fakes.js";
import { makeFakeTools, FakeGitProbe, commit } from "../verifier/deterministic/fakes.js";
import {
  InMemoryHoldoutStore,
  makeHoldoutRecord,
  FsHoldoutVerdictStore,
} from "../verifier/holdout/index.js";
import { InMemoryArtifactStore } from "./artifacts.js";
import { taskWorktreePath } from "./paths.js";
import { PANEL_ROLES } from "../verifier/judgment/index.js";
import { fakeUsageSignal, type UsageReading } from "../quota/usage-source.js";
import type { TaskState } from "../types/index.js";
import { ESCALATION_CAP } from "../producer/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000;

function reading(opts: {
  five: number;
  seven: number;
  fiveResets?: number;
  sevenResets?: number;
}): UsageReading {
  return {
    kind: "available",
    fiveHour: { utilizationPct: opts.five, resetsAtEpoch: opts.fiveResets ?? NOW + 18_000 },
    sevenDay: { utilizationPct: opts.seven, resetsAtEpoch: opts.sevenResets ?? NOW + 604_800 },
    capturedAt: NOW,
  };
}

const PROCEED = reading({ five: 0, seven: 0 });
const PAUSE_5H = reading({ five: 21, seven: 0 }); // 5h breach

function greenProbe(): FakeGitProbe {
  return new FakeGitProbe({
    refs: { "origin/staging": "sha-base", HEAD: "sha-head" },
    changedFiles: [],
    commits: [
      commit({ sha: "c1", files: ["src/x.test.ts"], tagged: true }),
      commit({ sha: "c2", files: ["src/x.ts"], tagged: true }),
    ],
  });
}

function makeSpec(
  tasks: ReadonlyArray<{
    task_id: string;
    acceptance_criteria?: readonly string[];
    tdd_exempt?: boolean;
    depends_on?: readonly string[];
    risk_tier?: "low" | "medium" | "high";
  }>,
): SpecManifest {
  return parseSpecManifest({
    spec_id: "42-checkout",
    issue_number: 42,
    slug: "checkout",
    repo: "acme/widgets",
    generated_at: "2026-06-01T00:00:00.000Z",
    tasks: tasks.map((t) => ({
      task_id: t.task_id,
      title: `task ${t.task_id}`,
      description: `does ${t.task_id}`,
      files: [`src/${t.task_id}.ts`],
      acceptance_criteria: t.acceptance_criteria ?? ["a", "b", "c"],
      tests_to_write: ["covers it"],
      depends_on: t.depends_on ?? [],
      risk_tier: t.risk_tier ?? "medium",
      risk_rationale: "moderate",
      ...(t.tdd_exempt === true ? { tdd_exempt: true } : {}),
    })),
  });
}

// ---------------------------------------------------------------------------
// makePumpDeps variants
// ---------------------------------------------------------------------------

interface MakePumpDepsOpts {
  /** Spec task overrides (default: one pending T1 with 3 acceptance criteria). */
  tasks?: ReadonlyArray<{
    task_id: string;
    acceptance_criteria?: readonly string[];
    tdd_exempt?: boolean;
    depends_on?: readonly string[];
    risk_tier?: "low" | "medium" | "high";
  }>;
  /** Seed task STATE overrides (over and above defaults). */
  taskStateOverrides?: Partial<TaskState> & { task_id?: string };
  /** Usage reading (default: PROCEED). */
  usage?: UsageReading;
  /** Whether to pre-seed a holdout record for T1 (default: true if ≥2 criteria). */
  withHoldout?: boolean;
  /** Ship mode (default: no-merge for test safety). */
  shipMode?: "live" | "no-merge";
  /** FakeGhClient factory (optional override for live-merge tests). */
  ghClient?: FakeGhClient;
}

interface PumpDepsResult {
  deps: PumpDeps;
  runId: string;
  dataDir: string;
  state: StateManager;
  holdout: InMemoryHoldoutStore;
  cleanup: () => Promise<void>;
}

async function makePumpDeps(opts: MakePumpDepsOpts = {}): Promise<PumpDepsResult> {
  const dataDir = await mkdtemp(join(tmpdir(), "factory-pump-"));
  const state = new StateManager({
    dataDir,
    lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
  });
  const holdout = new InMemoryHoldoutStore();
  const runId = "run-1";

  // Default to single criterion so holdout is not seeded (avoids verdict-store
  // read errors in tests that don't provide holdout results).
  const taskDefs = opts.tasks ?? [{ task_id: "T1", acceptance_criteria: ["only one"] }];

  const spec = makeSpec(taskDefs);

  await state.create({
    run_id: runId,
    spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
  });

  // Seed tasks — overrides apply only when task_id matches (or T1 by default)
  await state.update(runId, (s) => {
    const next = { ...s.tasks };
    for (const tDef of taskDefs) {
      const override =
        opts.taskStateOverrides !== undefined &&
        (opts.taskStateOverrides.task_id ?? "T1") === tDef.task_id
          ? opts.taskStateOverrides
          : {};
      next[tDef.task_id] = {
        task_id: tDef.task_id,
        status: override.status ?? "pending",
        depends_on: [...(tDef.depends_on ?? [])],
        risk_tier: tDef.risk_tier ?? "medium",
        escalation_rung: override.escalation_rung ?? 0,
        reviewers: override.reviewers ?? [],
        merge_resyncs: override.merge_resyncs ?? 0,
        ...(override.failure_class ? { failure_class: override.failure_class } : {}),
        ...(override.failure_reason ? { failure_reason: override.failure_reason } : {}),
        ...(override.stage ? { stage: override.stage } : {}),
        ...(override.pr_number ? { pr_number: override.pr_number } : {}),
        ...(override.branch ? { branch: override.branch } : {}),
      };
    }
    return { ...s, tasks: next };
  });

  const gh = opts.ghClient ?? new FakeGhClient();
  const git = new FakeGitClient({ remoteHeads: { staging: "sha-staging" } });

  const deps: PumpDeps = {
    config: defaultConfig(),
    spec,
    git,
    gh,
    tools: makeFakeTools({ git: greenProbe() }),
    artifacts: new InMemoryArtifactStore(),
    holdout,
    dataDir,
    owner: "acme",
    repo: "widgets",
    shipMode: opts.shipMode ?? "no-merge",
    state,
    usage: fakeUsageSignal(opts.usage ?? PROCEED),
    now: () => NOW,
  };

  return {
    deps,
    runId,
    dataDir,
    state,
    holdout,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Drive T1 through tests+exec (fold DONE twice) to land at the verify spawn.
 * Returns the verify spawn envelope (LOUD assertion — never returns non-spawn).
 * fold_key is echoed from each prior envelope, matching natural driver behavior.
 */
async function driveToVerify(
  deps: PumpDeps,
  runId: string,
  taskId: string,
): Promise<DriveEnvelope & { kind: "spawn" }> {
  // 1. First pump → tests spawn
  const env1 = await pumpTask(deps, runId, taskId);
  expect(env1.kind).toBe("spawn");
  if (env1.kind !== "spawn") throw new Error("expected spawn at tests");
  expect(env1.stage).toBe("tests");

  // 2. Fold DONE for tests → exec spawn (echo fold_key from env1)
  const env2 = await pumpTask(deps, runId, taskId, {
    fold_key: env1.fold_key,
    producer: { status: "STATUS: DONE" },
  });
  expect(env2.kind).toBe("spawn");
  if (env2.kind !== "spawn") throw new Error("expected spawn at exec");
  expect(env2.stage).toBe("exec");

  // 3. Fold DONE for exec → verify spawn (echo fold_key from env2)
  const env3 = await pumpTask(deps, runId, taskId, {
    fold_key: env2.fold_key,
    producer: { status: "STATUS: DONE" },
  });
  // Must be a verify spawn — LOUD assertion, never silently skip.
  expect(env3.kind).toBe("spawn");
  if (env3.kind !== "spawn") throw new Error("expected verify spawn after exec DONE");
  expect(env3.stage).toBe("verify");
  return env3;
}

/**
 * Build a DriveResults with 6 approving reviews (all PANEL_ROLES) + holdout pass.
 * fold_key is echoed from the prior spawn envelope.
 */
function approvingReviewsResults(
  priorEnvelope: DriveEnvelope & { kind: "spawn" },
  withheldCriteria?: readonly string[],
): DriveResults {
  const reviews = PANEL_ROLES.map((role) => ({
    reviewer: role,
    verdict: "approve" as const,
    findings: [],
  }));
  const result: DriveResults = {
    fold_key: priorEnvelope.fold_key,
    reviews: {
      reviews,
      verifications: [],
      crossVendorAbsent: { reason: "no cross-vendor reviewer configured" },
    },
  };
  if (withheldCriteria !== undefined && withheldCriteria.length > 0) {
    const holdoutRaw = JSON.stringify({
      criteria: withheldCriteria.map((c) => ({ criterion: c, satisfied: true, evidence: "ok" })),
    });
    return { ...result, holdout: { raw: holdoutRaw } };
  }
  return result;
}

/**
 * Build a DriveResults with one confirmed blocker from the first panel reviewer.
 * fold_key is echoed from the prior spawn envelope.
 */
function blockingReviewsResults(priorEnvelope: DriveEnvelope & { kind: "spawn" }): DriveResults {
  // Use the first PANEL_ROLES entry as the blocking reviewer (e.g. "implementation-reviewer")
  const blockerRole = PANEL_ROLES[0]!;
  const reviews = PANEL_ROLES.map((role) => ({
    reviewer: role,
    verdict: role === blockerRole ? ("blocked" as const) : ("approve" as const),
    findings:
      role === blockerRole
        ? [
            {
              reviewer: blockerRole,
              severity: "critical" as const,
              blocking: true,
              file: "src/x.ts",
              line: 1,
              quote: "bad code",
              description: "a blocker",
            },
          ]
        : [],
  }));
  return {
    fold_key: priorEnvelope.fold_key,
    reviews: {
      reviews,
      verifications: [
        {
          reviewer: blockerRole,
          verdicts: [{ file: "src/x.ts", line: 1, holds: true, note: "confirmed" }],
        },
      ],
      crossVendorAbsent: { reason: "no cross-vendor reviewer configured" },
    },
  };
}

// ---------------------------------------------------------------------------
// stage-cursor literals cross-module pin
// ---------------------------------------------------------------------------

describe("stage-cursor literals", () => {
  it("TaskState.stage enum equals TASK_STAGE_ORDER (cross-module pin)", () => {
    const stageField = TaskStateSchema.shape.stage;
    // stage is z.enum([...]).optional() — unwrap once to get the ZodEnum
    const stageEnum = stageField.unwrap();
    expect(stageEnum.options).toEqual([...TASK_STAGE_ORDER]);
  });
});

// ---------------------------------------------------------------------------
// pumpTask
// ---------------------------------------------------------------------------

describe("pumpTask", () => {
  it("fresh task pumps preflight deterministically and stops at the tests spawn", async () => {
    const { deps, runId, cleanup } = await makePumpDeps();
    try {
      const env = await pumpTask(deps, runId, "T1");
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.stage).toBe("tests");
      expect(env.expects).toBe("producer-status");
      expect(env.manifest.agents[0]?.role).toBe("test-writer");
      expect(env.fold_key).toEqual({ stage: "tests", rung: 0 });
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.stage).toBe("tests"); // cursor persisted
    } finally {
      await cleanup();
    }
  });

  it("re-invoking without results re-emits the same spawn envelope (idempotent)", async () => {
    const { deps, runId, cleanup } = await makePumpDeps();
    try {
      const a = await pumpTask(deps, runId, "T1");
      expect(a.kind).toBe("spawn");
      const b = await pumpTask(deps, runId, "T1");
      expect(b).toEqual(a);
    } finally {
      await cleanup();
    }
  });

  it("re-invoking at verify without results re-emits the same verify spawn (idempotent)", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c", "d", "e"] }],
    });
    try {
      const verifyEnv = await driveToVerify(deps, runId, "T1");
      // Two consecutive no-results pumps at verify must deep-equal the prior envelope.
      const a = await pumpTask(deps, runId, "T1");
      expect(a.kind).toBe("spawn");
      const b = await pumpTask(deps, runId, "T1");
      expect(b).toEqual(a);
      expect(a).toEqual(verifyEnv);
    } finally {
      await cleanup();
    }
  });

  it("folds a producer DONE and advances to the exec spawn", async () => {
    const { deps, runId, cleanup } = await makePumpDeps();
    try {
      const env1 = await pumpTask(deps, runId, "T1"); // → tests spawn
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;
      const env = await pumpTask(deps, runId, "T1", {
        fold_key: env1.fold_key,
        producer: { status: "STATUS: DONE" },
      });
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.stage).toBe("exec");
      expect(env.manifest.agents[0]?.role).toBe("executor");
    } finally {
      await cleanup();
    }
  });

  it("a blocked producer escalates the rung and re-spawns the same stage", async () => {
    const { deps, runId, cleanup } = await makePumpDeps();
    try {
      const env1 = await pumpTask(deps, runId, "T1");
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;
      // NEEDS_CONTEXT → capability retry → rung bump (not a spec-defect drop)
      const env = await pumpTask(deps, runId, "T1", {
        fold_key: env1.fold_key,
        producer: { status: "STATUS: NEEDS_CONTEXT" },
      });
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.stage).toBe("tests");
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.escalation_rung).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("verify emits the 6-reviewer panel, expects reviews", async () => {
    const { deps, runId, holdout, cleanup } = await makePumpDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c", "d", "e"] }],
    });
    try {
      // Seed a holdout record so the sidecar is emitted
      await holdout.put(runId, makeHoldoutRecord("T1", ["d", "e"], 5));
      await driveToVerify(deps, runId, "T1");
      const env = await pumpTask(deps, runId, "T1");
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.stage).toBe("verify");
      expect(env.expects).toBe("reviews");
      expect(env.manifest.agents).toHaveLength(PANEL_ROLES.length);
      expect(env.sidecar?.kind).toBe("holdout-validate");
      expect(env.worktree).toContain("T1");
    } finally {
      await cleanup();
    }
  });

  it("folding approving reviews (+holdout pass) pumps through ship to terminal done (no-merge)", async () => {
    // Use ≥2 criteria so the tests stage persists a holdout record (holdoutCount(2,20)=1).
    const { deps, runId, dataDir, cleanup } = await makePumpDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["criterion-a", "criterion-b"] }],
    });
    try {
      await driveToVerify(deps, runId, "T1");
      // Read the withheld record that the tests stage persisted.
      const holdoutRecord = await deps.holdout.get(runId, "T1");
      const withheld = holdoutRecord.withheld_criteria;
      expect(withheld.length).toBeGreaterThan(0); // sanity: split actually withheld something

      const panelEnv = await pumpTask(deps, runId, "T1"); // emit panel + holdout sidecar
      expect(panelEnv.kind).toBe("spawn");
      if (panelEnv.kind !== "spawn") return;
      // Fold approving reviews AND holdout pass (withheld criteria → all satisfied).
      const env = await pumpTask(deps, runId, "T1", approvingReviewsResults(panelEnv, withheld));
      expect(env).toMatchObject({ kind: "terminal", outcome: { outcome: "done" } });
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.status).toBe("done");
      expect(run.tasks["T1"]?.pr_number).toBeTypeOf("number");

      // Assert the holdout fold path actually fired: verdict store has entries for T1.
      const verdictStore = new FsHoldoutVerdictStore(dataDir);
      const verdicts = await verdictStore.get(runId, "T1");
      expect(verdicts.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("a blocked floor escalates and resumes at exec", async () => {
    const { deps, runId, dataDir, cleanup } = await makePumpDeps();
    try {
      await driveToVerify(deps, runId, "T1");
      // Write the cited file into the worktree so citation-verify can confirm it.
      const worktree = taskWorktreePath(dataDir, runId, "T1");
      const citedFile = join(worktree, "src", "x.ts");
      await mkdir(dirname(citedFile), { recursive: true });
      await writeFile(citedFile, "bad code\n");
      const panelEnv = await pumpTask(deps, runId, "T1");
      expect(panelEnv.kind).toBe("spawn");
      if (panelEnv.kind !== "spawn") return;
      const env = await pumpTask(deps, runId, "T1", blockingReviewsResults(panelEnv));
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.stage).toBe("exec");
    } finally {
      await cleanup();
    }
  });

  it("an exhausted ladder is a classified capability-budget drop", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({
      taskStateOverrides: { task_id: "T1", escalation_rung: ESCALATION_CAP },
    });
    try {
      const env1 = await pumpTask(deps, runId, "T1");
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;
      // NEEDS_CONTEXT → capability retry → rung already at cap → drops capability-budget
      const env = await pumpTask(deps, runId, "T1", {
        fold_key: env1.fold_key,
        producer: { status: "STATUS: NEEDS_CONTEXT" },
      });
      expect(env).toMatchObject({
        kind: "terminal",
        outcome: { outcome: "dropped", failure_class: "capability-budget" },
      });
    } finally {
      await cleanup();
    }
  });

  it("live-merge BEHIND exhausted cap drops blocked-environmental", async () => {
    // Pre-seed an OPEN-but-BEHIND PR so every merge attempt refuses.
    const gh = new FakeGhClient();
    const branch = "factory/run-1/T1";
    gh.setPr({
      number: 500,
      headRefName: branch,
      baseRefName: "staging",
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
      url: "https://github.com/fake/repo/pull/500",
    });
    const { deps, runId, cleanup } = await makePumpDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c"] }],
      shipMode: "live",
      ghClient: gh,
      taskStateOverrides: {
        task_id: "T1",
        stage: "ship" as const,
        status: "shipping",
        merge_resyncs: MERGE_RESYNC_CAP,
        branch,
        pr_number: 500,
      },
    });
    try {
      const env = await pumpTask(deps, runId, "T1");
      expect(env).toMatchObject({
        kind: "terminal",
        outcome: { outcome: "dropped", failure_class: "blocked-environmental" },
      });
    } finally {
      await cleanup();
    }
  });

  it("results at a non-spawn stage (preflight) fail loud", async () => {
    const { deps, runId, cleanup } = await makePumpDeps();
    try {
      // T1 is pending → stage is implicitly preflight (no cursor yet)
      await expect(
        pumpTask(deps, runId, "T1", {
          fold_key: { stage: "tests", rung: 0 },
          producer: { status: "STATUS: DONE" },
        }),
      ).rejects.toThrow(/spawns no agents|preflight/i);
    } finally {
      await cleanup();
    }
  });

  it("producer results at verify fail loud (expects mismatch)", async () => {
    const { deps, runId, cleanup } = await makePumpDeps();
    try {
      await driveToVerify(deps, runId, "T1");
      const panelEnv = await pumpTask(deps, runId, "T1"); // emit panel → stage cursor = "verify"
      expect(panelEnv.kind).toBe("spawn");
      if (panelEnv.kind !== "spawn") return;
      await expect(
        pumpTask(deps, runId, "T1", {
          fold_key: panelEnv.fold_key,
          producer: { status: "STATUS: DONE" },
        }),
      ).rejects.toThrow(/expects reviews/i);
    } finally {
      await cleanup();
    }
  });

  it("a quota breach short-circuits to quota-blocked before any stage work", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({ usage: PAUSE_5H });
    try {
      const env = await pumpTask(deps, runId, "T1");
      expect(env).toMatchObject({ kind: "quota-blocked", scope: "5h" });
      // No stage cursor was written — the pump bailed before any stage work.
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.stage).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("a terminal task returns its terminal envelope idempotently", async () => {
    const { deps, runId, state, cleanup } = await makePumpDeps();
    try {
      // Seed the task as done
      await state.update(runId, (s) => ({
        ...s,
        tasks: {
          T1: {
            ...s.tasks["T1"]!,
            status: "done",
          },
        },
      }));
      const env = await pumpTask(deps, runId, "T1");
      expect(env).toMatchObject({ kind: "terminal", outcome: { outcome: "done" } });
    } finally {
      await cleanup();
    }
  });

  it("stale results (fold_key tests/0) reject LOUD after DONE advances tests→exec", async () => {
    const { deps, runId, cleanup } = await makePumpDeps();
    try {
      const env1 = await pumpTask(deps, runId, "T1"); // tests spawn, fold_key tests/0
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") throw new Error("expected spawn");
      const testsResults: DriveResults = {
        fold_key: env1.fold_key, // { stage: "tests", rung: 0 }
        producer: { status: "STATUS: DONE" },
      };
      // Fold DONE: advances cursor to exec.
      const env2 = await pumpTask(deps, runId, "T1", testsResults);
      expect(env2.kind).toBe("spawn");
      if (env2.kind !== "spawn") throw new Error("expected exec spawn");
      expect(env2.stage).toBe("exec");

      // Re-deliver the SAME results (fold_key tests/0) after cursor moved to exec/0.
      await expect(pumpTask(deps, runId, "T1", testsResults)).rejects.toThrow(/stale or duplicate/);
    } finally {
      await cleanup();
    }
  });

  it("duplicate NEEDS_CONTEXT results (fold_key tests/0) reject LOUD and do not double-bump escalation_rung", async () => {
    const { deps, runId, cleanup } = await makePumpDeps();
    try {
      const env1 = await pumpTask(deps, runId, "T1"); // tests spawn, fold_key tests/0
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") throw new Error("expected spawn");
      const needsContextResults: DriveResults = {
        fold_key: env1.fold_key, // { stage: "tests", rung: 0 }
        producer: { status: "STATUS: NEEDS_CONTEXT" },
      };
      // First fold: bumps escalation_rung to 1.
      const env2 = await pumpTask(deps, runId, "T1", needsContextResults);
      expect(env2.kind).toBe("spawn");
      if (env2.kind !== "spawn") throw new Error("expected spawn after escalation");
      expect(env2.stage).toBe("tests");
      const runAfter = await deps.state.read(runId);
      expect(runAfter.tasks["T1"]?.escalation_rung).toBe(1);

      // Re-deliver the SAME results (fold_key tests/0) — rung is now 1, mismatch.
      await expect(pumpTask(deps, runId, "T1", needsContextResults)).rejects.toThrow(
        /stale or duplicate/,
      );
      // Rung must still be 1 — no double-bump.
      const runFinal = await deps.state.read(runId);
      expect(runFinal.tasks["T1"]?.escalation_rung).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("spawn envelope carries fold_key that matches cursor stage and rung", async () => {
    const { deps, runId, cleanup } = await makePumpDeps({
      taskStateOverrides: { task_id: "T1", escalation_rung: 2 },
    });
    try {
      const env = await pumpTask(deps, runId, "T1");
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.fold_key).toEqual({ stage: env.stage, rung: 2 });
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 2: terminal check precedes quota gate
// ---------------------------------------------------------------------------

describe("terminal-before-quota ordering", () => {
  it("terminal task + quota-breach → returns terminal envelope (no pause checkpoint)", async () => {
    // PAUSE_5H would normally trigger quota-blocked; terminal status must short-circuit first.
    const { deps, runId, state, cleanup } = await makePumpDeps({ usage: PAUSE_5H });
    try {
      // Seed the task as done (terminal).
      await state.update(runId, (s) => ({
        ...s,
        tasks: { T1: { ...s.tasks["T1"]!, status: "done" } },
      }));
      const env = await pumpTask(deps, runId, "T1");
      // Must be terminal, NOT quota-blocked.
      expect(env).toMatchObject({ kind: "terminal", outcome: { outcome: "done" } });
      // No pause checkpoint was written (quota gate never ran).
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.stage).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 1b: handlers.verify fail-closed re-spawn when holdout expected but no verdict
// ---------------------------------------------------------------------------

describe("handlers.verify fail-closed re-spawn (crash-resume guard)", () => {
  it("task at verify with pre-persisted reviewers + holdout expected + no verdict → re-spawns panel", async () => {
    // Simulate a rogue hook write: task arrives at pump with reviewers[] already populated
    // and stage=verify, but no holdout verdict has been recorded yet.
    // Expected: the verify handler detects missing holdout evidence and re-spawns the panel
    // (fail-closed), NOT derives from the persisted reviewers and advances to ship.
    const { deps, runId, state, holdout, cleanup } = await makePumpDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c"] }],
      taskStateOverrides: {
        task_id: "T1",
        stage: "verify" as const,
        status: "reviewing",
        // Pre-populate reviewers as if a rogue hook wrote them.
        reviewers: PANEL_ROLES.map((role) => ({
          reviewer: role,
          verdict: "approve" as const,
          confirmed_blockers: 0,
        })),
      },
    });
    try {
      // Seed a holdout answer key (so holdout.has returns true) but do NOT write verdicts.
      await holdout.put(runId, makeHoldoutRecord("T1", ["c"], 3));
      // No verdict store entry — simulates the crash-between-hook-write-and-fold scenario.

      const env = await pumpTask(deps, runId, "T1");
      // Must re-spawn the verify panel, NOT advance to ship.
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") throw new Error("expected spawn envelope for fail-closed re-spawn");
      expect(env.stage).toBe("verify");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 3: foldResults requires holdout results when answer key is withheld
// ---------------------------------------------------------------------------

describe("foldResults holdout-required guard", () => {
  it("holdout-bearing task at verify with reviews but no holdout → rejects with /holdout/", async () => {
    // 5 criteria at holdoutPercent=20% → holdoutCount(5,20)=1 — guarantees a withheld key.
    const { deps, runId, cleanup } = await makePumpDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c", "d", "e"] }],
    });
    try {
      await driveToVerify(deps, runId, "T1");
      const panelEnv = await pumpTask(deps, runId, "T1");
      expect(panelEnv.kind).toBe("spawn");
      if (panelEnv.kind !== "spawn") throw new Error("expected panel spawn");
      expect(panelEnv.sidecar?.kind).toBe("holdout-validate"); // sanity: holdout was withheld

      // Deliver reviews WITHOUT the holdout field (no withheld arg → no holdout in results).
      const resultsWithoutHoldout = approvingReviewsResults(panelEnv);
      // The holdout store has an entry (tests stage persisted it) but results.holdout is absent.
      await expect(pumpTask(deps, runId, "T1", resultsWithoutHoldout)).rejects.toThrow(/holdout/);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// fold_key schema rejection (schema-level, not pump-level)
// ---------------------------------------------------------------------------

describe("fold_key validation (Important 1 — schema gate)", () => {
  it("fold_key mismatch on stage rejects with /stale or duplicate/", async () => {
    const { deps, runId, cleanup } = await makePumpDeps();
    try {
      const env1 = await pumpTask(deps, runId, "T1");
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;
      // Lie: claim fold_key.stage is "exec" but cursor is "tests"
      const wrongKey: FoldKey = { stage: "exec", rung: 0 };
      await expect(
        pumpTask(deps, runId, "T1", { fold_key: wrongKey, producer: { status: "STATUS: DONE" } }),
      ).rejects.toThrow(/stale or duplicate/);
    } finally {
      await cleanup();
    }
  });

  it("fold_key mismatch on rung rejects with /stale or duplicate/", async () => {
    const { deps, runId, cleanup } = await makePumpDeps();
    try {
      const env1 = await pumpTask(deps, runId, "T1");
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;
      // Lie: claim rung 99 but actual is 0
      const wrongKey: FoldKey = { stage: "tests", rung: 99 };
      await expect(
        pumpTask(deps, runId, "T1", { fold_key: wrongKey, producer: { status: "STATUS: DONE" } }),
      ).rejects.toThrow(/stale or duplicate/);
    } finally {
      await cleanup();
    }
  });
});
