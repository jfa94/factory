/**
 * Seam-contract E2E for the v1 execution model (orchestrator-as-driver, Model A).
 *
 * Replaces the old `run-task`/`record-*`/`advance` CLI-subcommand driving loop with
 * the canonical pump seam:
 *
 *   pumpRun  → tasks-ready | all-terminal | run-terminal | quota-blocked
 *   pumpTask → spawn | terminal | quota-blocked
 *
 * The `driveToTerminal` helper below IS the documented driver contract: it is the
 * thinnest possible loop a real orchestrator (session or workflow) runs.  The test's
 * job is to prove that CONTRACT produces the right run-state end-states — not to test
 * individual pump internals (those live in pump.test.ts / next.test.ts).
 *
 * Three scenarios are proven:
 *   1. Happy path (no-merge): single task → `completed`, PR opened but NOT merged,
 *      holdout sidecar surfaced + folded, all six panel reviewers approved.
 *   2. Happy path (live): same chain → `completed`, PR merged.
 *   3. Drop path: two-task run; second task at escalation cap → drops as
 *      `capability-budget`; `finalizeRun` produces a `partial` run (one done, one
 *      dropped) and files one failure issue.
 *
 * The holdout path (scenario 1/2 trait): the spec carries 5 acceptance criteria, so
 * the tests stage withholds ≥1 criterion, the verify spawn carries a holdout sidecar,
 * and the AnswerBook supplies `results.holdout` (validator verdicts) alongside the
 * panel reviews — the engine rejects the fold without it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRun } from "./subcommands/run.js";

import { defaultConfig } from "../config/schema.js";
import { parseSpecManifest, SpecStore, type SpecManifest } from "../spec/index.js";
import { StateManager } from "../core/state/manager.js";
import { FakeGitClient, FakeGhClient } from "../git/fakes.js";
import { makeFakeTools, FakeGitProbe, commit } from "../verifier/deterministic/fakes.js";
import { InMemoryHoldoutStore } from "../verifier/holdout/index.js";
import { InMemoryArtifactStore, type ShipMode } from "../driver/index.js";
import { PANEL_ROLES } from "../verifier/judgment/index.js";
import { fakeUsageSignal } from "../quota/index.js";
import type { RunState } from "../types/index.js";

import {
  pumpRun,
  pumpTask,
  finalizeRun,
  type PumpDeps,
  type DriveEnvelope,
  type DriveResults,
} from "../driver/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUN_ID = "run-1";
const TASK_ID = "t1";
const TASK_ID_2 = "t2";
const REPO = "acme/widgets";
const ISSUE = 42;
const SLUG = "checkout";

/** Epoch second used as `now()` for the quota clock (pinned; tests never breach). */
const NOW_EPOCH = 1_700_000_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A git probe whose full default gate sweep is GREEN (TDD test→impl history). */
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

/** One durable spec: a single task with 5 criteria (so the holdout withholds ≥1). */
function specManifestSingle(): SpecManifest {
  return parseSpecManifest({
    spec_id: `${ISSUE}-${SLUG}`,
    issue_number: ISSUE,
    slug: SLUG,
    repo: REPO,
    generated_at: "2026-06-01T00:00:00.000Z",
    tasks: [
      {
        task_id: TASK_ID,
        title: "task t1",
        description: "does t1",
        files: ["src/t1.ts"],
        acceptance_criteria: ["a", "b", "c", "d", "e"],
        tests_to_write: ["t1.test.ts: covers it"],
        depends_on: [],
        risk_tier: "medium",
        risk_rationale: "moderate",
      },
    ],
  });
}

/** Two-task spec: t1 (3 criteria) + t2 (at cap). Used for the drop-path scenario. */
function specManifestTwo(): SpecManifest {
  return parseSpecManifest({
    spec_id: `${ISSUE}-${SLUG}`,
    issue_number: ISSUE,
    slug: SLUG,
    repo: REPO,
    generated_at: "2026-06-01T00:00:00.000Z",
    tasks: [
      {
        task_id: TASK_ID,
        title: "task t1",
        description: "does t1",
        files: ["src/t1.ts"],
        acceptance_criteria: ["a", "b", "c"],
        tests_to_write: ["t1.test.ts: covers it"],
        depends_on: [],
        risk_tier: "medium",
        risk_rationale: "moderate",
      },
      {
        task_id: TASK_ID_2,
        title: "task t2 (will drop)",
        description: "does t2",
        files: ["src/t2.ts"],
        acceptance_criteria: ["x", "y"],
        tests_to_write: ["t2.test.ts: covers it"],
        depends_on: [],
        risk_tier: "medium",
        risk_rationale: "moderate",
      },
    ],
  });
}

/** An approving RawReview-shaped object (the orchestrator's collected panel output). */
function approve(reviewer: string) {
  return { reviewer, verdict: "approve" as const, findings: [] };
}

// ---------------------------------------------------------------------------
// AnswerBook — canned DriveResults per spawn envelope
// ---------------------------------------------------------------------------

/**
 * Maps `(task_id, stage)` → a factory that, given the spawn envelope, produces
 * the appropriate {@link DriveResults}.  The fold_key is taken verbatim from the
 * envelope so the engine's exactly-once gate always passes.
 *
 * Usage: `book.for(env)` — call once per spawn envelope in the driver loop.
 */
class AnswerBook {
  private readonly producerStatuses: Map<string, string>;
  private readonly holdout: Map<string, InMemoryHoldoutStore>;

  constructor(
    opts: {
      /** producer STATUS line per task_id (default: "STATUS: DONE" for everything). */
      producerStatuses?: Record<string, string>;
      /** holdout store shared with the test (so allPass verdicts can be derived). */
      holdoutStore?: InMemoryHoldoutStore;
      /** run id (for holdout lookups). */
      runId?: string;
    } = {},
  ) {
    this.producerStatuses = new Map(Object.entries(opts.producerStatuses ?? {}));
    this.holdout = new Map();
    if (opts.holdoutStore !== undefined && opts.runId !== undefined) {
      this.holdout.set(opts.runId, opts.holdoutStore);
    }
  }

  /**
   * Build DriveResults for the given spawn envelope, echoing fold_key verbatim.
   * For `producer-status` expects: returns the canned STATUS line.
   * For `reviews` expects: returns all-approve panel + all-pass holdout (when sidecar).
   */
  async for(env: DriveEnvelope & { kind: "spawn" }): Promise<DriveResults> {
    if (env.expects === "producer-status") {
      const statusLine = this.producerStatuses.get(env.task_id) ?? "STATUS: DONE";
      return {
        fold_key: env.fold_key,
        producer: { status: statusLine },
      };
    }

    // expects === "reviews" (verify stage)
    const reviews = PANEL_ROLES.map((role) => approve(role));
    const base: DriveResults = {
      fold_key: env.fold_key,
      reviews: {
        reviews,
        verifications: [],
        crossVendorAbsent: { reason: "single-vendor v1 (no second vendor configured)" },
      },
    };

    // If the spawn carries a holdout sidecar, the fold requires holdout results.
    if (env.sidecar !== undefined) {
      const holdoutStore = this.holdout.get(env.run_id);
      if (holdoutStore === undefined) {
        throw new Error(
          `AnswerBook: spawn for task '${env.task_id}' carries a holdout sidecar but no ` +
            `holdout store was registered for run '${env.run_id}'`,
        );
      }
      const record = await holdoutStore.get(env.run_id, env.task_id);
      const raw = JSON.stringify({
        criteria: record.withheld_criteria.map((criterion: string) => ({
          criterion,
          satisfied: true,
          evidence: "src/t1.ts:1",
        })),
      });
      return { ...base, holdout: { raw } };
    }

    return base;
  }
}

// ---------------------------------------------------------------------------
// driveToTerminal — the canonical thin driver loop (IS the contract)
// ---------------------------------------------------------------------------

/**
 * Drive a run to its terminal state, exactly as a real in-session or workflow
 * driver would.  This loop IS the documented driver contract:
 *
 *   pumpRun → ready → pumpTask (fold results) loop → terminal → repeat
 *
 * Sequential: one task at a time (first ready task from pumpRun).
 * Quota-blocked is treated as an unexpected error (the fake signal never blocks).
 */
async function driveToTerminal(
  deps: PumpDeps,
  runId: string,
  answer: AnswerBook,
): Promise<RunState> {
  for (;;) {
    const next = await pumpRun(deps, runId);
    if (next.kind === "run-terminal") return deps.state.read(runId);
    if (next.kind === "all-terminal") {
      await finalizeRun(deps, runId);
      return deps.state.read(runId);
    }
    if (next.kind === "quota-blocked") throw new Error(`unexpected quota stop: ${next.reason}`);

    const taskId = next.ready[0]!; // sequential driver: first ready task
    let results: DriveResults | undefined;
    for (;;) {
      const env = await pumpTask(deps, runId, taskId, results);
      results = undefined;
      if (env.kind === "terminal") break;
      if (env.kind !== "spawn") throw new Error(`unexpected ${env.kind}`);
      results = await answer.for(env);
    }
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("orchestrator pump seam — golden contract E2E", () => {
  let dataDir: string;
  let state: StateManager;
  let specStore: SpecStore;
  let git: FakeGitClient;
  let gh: FakeGhClient;
  let holdout: InMemoryHoldoutStore;
  let artifacts: InMemoryArtifactStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-orch-e2e-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    specStore = new SpecStore({ dataDir });
    git = new FakeGitClient({ remoteHeads: { staging: "sha-staging" } });
    gh = new FakeGhClient();
    holdout = new InMemoryHoldoutStore();
    artifacts = new InMemoryArtifactStore();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Build PumpDeps directly (no CLI loading — keeps the E2E free of fs config). */
  function makeDeps(
    manifest: SpecManifest,
    shipMode: ShipMode,
    ghClient: FakeGhClient = gh,
  ): PumpDeps {
    return {
      config: defaultConfig(),
      spec: manifest,
      git,
      gh: ghClient,
      tools: makeFakeTools({ git: greenProbe() }),
      artifacts,
      holdout,
      dataDir,
      owner: "acme",
      repo: "widgets",
      shipMode,
      state,
      usage: fakeUsageSignal({
        kind: "available",
        fiveHour: { utilizationPct: 0, resetsAtEpoch: NOW_EPOCH + 18_000 },
        sevenDay: { utilizationPct: 0, resetsAtEpoch: NOW_EPOCH + 604_800 },
        capturedAt: NOW_EPOCH,
      }),
      now: () => NOW_EPOCH,
    };
  }

  // -------------------------------------------------------------------------
  // Scenario 1: Happy path (no-merge) — single task → completed, holdout path
  // -------------------------------------------------------------------------

  it("drives a task PRD→shipped (no-merge), holdout sidecar folded, panel all-approve", async () => {
    const manifest = specManifestSingle();
    await specStore.write(manifest, "# checkout spec\n\nvertical slice.");

    const run = await createRun(state, specStore, {
      repo: REPO,
      issue: ISSUE,
      driver: "balanced",
      runId: RUN_ID,
    });
    expect(run.run_id).toBe(RUN_ID);
    expect(Object.keys(run.tasks)).toEqual([TASK_ID]);
    expect(run.tasks[TASK_ID]!.status).toBe("pending");

    const deps = makeDeps(manifest, "no-merge");
    const answer = new AnswerBook({ holdoutStore: holdout, runId: RUN_ID });

    // Track whether the verify spawn carried a holdout sidecar (proves Δ Y path).
    // We intercept in driveToTerminal by passing a counting wrapper directly.
    let sawHoldoutSidecar = false;
    const trackingSidecar: typeof answer = Object.create(answer) as typeof answer;
    trackingSidecar.for = async (env: DriveEnvelope & { kind: "spawn" }) => {
      if (env.sidecar !== undefined) sawHoldoutSidecar = true;
      return answer.for(env);
    };

    const finalRun = await driveToTerminal(deps, RUN_ID, trackingSidecar);

    // The run reached `completed` (all tasks done).
    expect(finalRun.status).toBe("completed");

    // The task reached `done` with branch + PR recorded.
    const task = finalRun.tasks[TASK_ID]!;
    expect(task.status).toBe("done");
    expect(task.branch).toBe(`factory/${RUN_ID}/${TASK_ID}`);
    expect(task.pr_number).toBeDefined();

    // Dry-run: task PR opened but NEVER merged (cutover-safety invariant).
    // finalizeRun also opens a rollup PR (staging→develop), so total created = 2.
    const taskPrs = gh.created.filter((p) => p.head === `factory/${RUN_ID}/${TASK_ID}`);
    expect(taskPrs).toHaveLength(1);
    expect(gh.merges).toHaveLength(0);

    // The holdout path: 5-criteria spec withholds ≥1 → verify emits a sidecar.
    expect(sawHoldoutSidecar).toBe(true);

    // The risk-invariant panel: all six roles ran and the task reviewers were recorded.
    expect(task.reviewers).toHaveLength(PANEL_ROLES.length);
    expect(task.reviewers.every((r) => r.verdict === "approve")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Happy path (live) — same chain, PR merged
  // -------------------------------------------------------------------------

  it("serial-merges the task PR in live ship mode (same chain)", async () => {
    const manifest = specManifestSingle();
    await specStore.write(manifest, "# checkout spec\n\nvertical slice.");

    await createRun(state, specStore, {
      repo: REPO,
      issue: ISSUE,
      driver: "balanced",
      runId: RUN_ID,
    });

    const deps = makeDeps(manifest, "live");
    const answer = new AnswerBook({ holdoutStore: holdout, runId: RUN_ID });
    const finalRun = await driveToTerminal(deps, RUN_ID, answer);

    expect(finalRun.status).toBe("completed");
    expect(finalRun.tasks[TASK_ID]!.status).toBe("done");

    // Live: the task PR was opened AND serial-merged into staging.
    // finalizeRun also opens+merges a rollup PR, so merges total = 2.
    const taskPrs = gh.created.filter((p) => p.head === `factory/${RUN_ID}/${TASK_ID}`);
    expect(taskPrs).toHaveLength(1);
    expect(gh.merges.length).toBeGreaterThanOrEqual(1); // task PR merge + rollup merge
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Drop path — capability-budget drop → partial finalize
  // -------------------------------------------------------------------------

  it("drops a task at escalation cap → capability-budget → finalizeRun produces partial", async () => {
    const manifest = specManifestTwo();
    await specStore.write(manifest, "# checkout spec\n\nvertical slice.");

    await createRun(state, specStore, {
      repo: REPO,
      issue: ISSUE,
      driver: "balanced",
      runId: RUN_ID,
    });

    // Seed t2 at ESCALATION_CAP (rung=2) so the first producer failure drops it.
    await state.updateTask(RUN_ID, TASK_ID_2, (t) => ({ ...t, escalation_rung: 2 }));

    const deps = makeDeps(manifest, "no-merge");

    // t1: DONE normally. t2: BLOCKED at tests (at cap → capability-budget drop).
    const answer = new AnswerBook({
      holdoutStore: holdout,
      runId: RUN_ID,
      producerStatuses: {
        [TASK_ID_2]: "STATUS: BLOCKED: ran out of ideas",
      },
    });

    const finalRun = await driveToTerminal(deps, RUN_ID, answer);

    // The run ended as `partial` (one done, one dropped).
    expect(finalRun.status).toBe("partial");

    // t1 shipped normally.
    expect(finalRun.tasks[TASK_ID]!.status).toBe("done");

    // t2 was dropped as capability-budget.
    const droppedTask = finalRun.tasks[TASK_ID_2]!;
    expect(droppedTask.status).toBe("dropped");
    expect(droppedTask.failure_class).toBe("capability-budget");

    // finalizeRun filed one failure issue for t2.
    expect(gh.issues).toHaveLength(1);
  });
});
