/**
 * Seam-contract E2E for the v1 execution model (runner-as-orchestrator, Model A).
 *
 * Replaces the old `run-task`/`record-*`/`advance` CLI-subcommand driving loop with
 * the canonical orchestrator seam:
 *
 *   nextTask  → tasks-ready | all-terminal | run-terminal | quota-blocked
 *   nextAction → spawn | terminal | quota-blocked
 *
 * The `driveToTerminal` helper below IS the documented orchestrator contract: it is the
 * thinnest possible loop a real runner (session or workflow) runs.  The test's
 * job is to prove that CONTRACT produces the right run-state end-states — not to test
 * individual orchestrator internals (those live in orchestrator.test.ts / next.test.ts).
 *
 * Three scenarios are proven:
 *   1. Happy path (no-merge): single task → `completed`, PR opened but NOT merged,
 *      holdout holdout surfaced + recorded, all six panel reviewers approved.
 *   2. Happy path (live): same chain → `completed`, PR merged.
 *   3. Drop path: two-task run; second task at escalation cap → fails as
 *      `capability-budget`; `finalizeRun` produces a `failed` run (Decision 34:
 *      develop receives only complete PRDs) and posts one PRD-issue failure comment.
 *
 * The holdout path (scenario 1/2 trait): the spec carries 5 acceptance criteria, so
 * the tests phase withholds ≥1 criterion, the verify spawn carries a holdout holdout,
 * and the AnswerBook supplies `results.holdout` (validator verdicts) alongside the
 * panel reviews — the engine rejects the record without it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRun } from "./subcommands/run.js";

import { defaultConfig } from "../config/schema.js";
import { SpecStore, type SpecManifest } from "../spec/index.js";
import { StateManager } from "../core/state/manager.js";
import { FakeGitClient, FakeGhClient } from "../git/fakes.js";
import { makeFakeTools } from "../verifier/deterministic/fakes.js";
import { type HoldoutStore, InMemoryHoldoutStore } from "../verifier/holdout/index.js";
import { InMemoryArtifactStore, type ShipMode } from "../orchestrator/index.js";
import { PANEL_ROLES } from "../verifier/judgment/index.js";
import { fakeUsageSignal } from "../quota/index.js";
import { ESCALATION_CAP } from "../producer/index.js";
import type { RunState } from "../types/index.js";

import {
  nextTask,
  nextAction,
  finalizeRun,
  type OrchestratorDeps,
  type NextAction,
  type DriveResults,
} from "../orchestrator/index.js";

import { greenProbe, makeSpec, NOW } from "../orchestrator/orchestrator-fixtures.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUN_ID = "run-1";
const TASK_ID = "t1";
const TASK_ID_2 = "t2";
const REPO = "acme/widgets";
const ISSUE = 42;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One durable spec: a single task with 5 criteria (so the holdout withholds ≥1). */
function specManifestSingle(): SpecManifest {
  return makeSpec([{ task_id: TASK_ID, acceptance_criteria: ["a", "b", "c", "d", "e"] }]);
}

/** Two-task spec: t1 (3 criteria) + t2 (2 criteria, seeded at escalation cap in the test body). */
function specManifestTwo(): SpecManifest {
  return makeSpec([
    { task_id: TASK_ID, acceptance_criteria: ["a", "b", "c"] },
    { task_id: TASK_ID_2, acceptance_criteria: ["x", "y"] },
  ]);
}

/** An approving RawReview-shaped object (the runner's collected panel output). */
function approve(reviewer: string) {
  return { reviewer, verdict: "approve" as const, findings: [] };
}

// ---------------------------------------------------------------------------
// AnswerBook — canned DriveResults per spawn envelope
// ---------------------------------------------------------------------------

/**
 * Canned answer store for spawn envelopes.  Dispatches on `env.expects`:
 *   - `"producer-status"` → returns the STATUS line keyed by `env.task_id` from
 *     the pre-seeded producerStatuses map (default: "STATUS: DONE").
 *   - `"reviews"` → returns an all-approve panel; if `env.holdout` is present,
 *     fetches the holdout record from the registered store and records in all-pass
 *     validator verdicts.  `env.result_key` is echoed verbatim so the engine's
 *     exactly-once gate always passes.
 *
 * Usage: `book.for(env)` — call once per spawn envelope in the runner loop.
 */
class AnswerBook {
  private readonly producerStatuses: Map<string, string>;
  private readonly holdout: { runId: string; store: HoldoutStore } | undefined;

  constructor(
    opts: {
      /** producer STATUS line per task_id (default: "STATUS: DONE" for everything). */
      producerStatuses?: Record<string, string>;
      /** holdout store + run id (both required together; meaningful only as a pair). */
      holdout?: { runId: string; store: HoldoutStore };
    } = {},
  ) {
    this.producerStatuses = new Map(Object.entries(opts.producerStatuses ?? {}));
    this.holdout = opts.holdout;
  }

  /**
   * Build DriveResults for the given spawn envelope, echoing result_key verbatim.
   * For `producer-status` expects: returns the canned STATUS line.
   * For `reviews` expects: returns all-approve panel + all-pass holdout (when holdout).
   */
  async for(env: NextAction & { kind: "spawn" }): Promise<DriveResults> {
    if (env.expects === "producer-status") {
      const statusLine = this.producerStatuses.get(env.task_id) ?? "STATUS: DONE";
      return {
        result_key: env.result_key,
        producer: { status: statusLine },
      };
    }

    // expects === "reviews" (verify phase)
    const reviews = PANEL_ROLES.map((role) => approve(role));
    const base: DriveResults = {
      result_key: env.result_key,
      reviews: {
        reviews,
        verifications: [],
        crossVendorAbsent: { reason: "single-vendor v1 (no second vendor configured)" },
      },
    };

    // If the spawn carries a holdout holdout, the record requires holdout results.
    if (env.holdout !== undefined) {
      if (this.holdout === undefined) {
        throw new Error(
          `AnswerBook: spawn for task '${env.task_id}' carries a holdout holdout but no ` +
            `holdout store was registered for run '${env.run_id}'`,
        );
      }
      const record = await this.holdout.store.get(env.run_id, env.task_id);
      const raw = JSON.stringify({
        criteria: record.withheld_criteria.map((criterion) => ({
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
// driveToTerminal — the canonical thin runner loop (IS the contract)
// ---------------------------------------------------------------------------

/** Minimal interface driveToTerminal needs — satisfied by AnswerBook and plain spy objects. */
interface Answerer {
  for(env: NextAction & { kind: "spawn" }): Promise<DriveResults>;
}

/**
 * Drive a run to its terminal state, exactly as a real in-session or workflow
 * orchestrator would.  This loop IS the documented orchestrator contract:
 *
 *   nextTask → ready → nextAction (record results) loop → terminal → repeat
 *
 * Sequential: one task at a time (first ready task from nextTask).
 * Quota-blocked is treated as an unexpected error (the fake signal never blocks).
 */

async function driveToTerminal(
  deps: OrchestratorDeps,
  runId: string,
  answer: Answerer,
): Promise<RunState> {
  for (;;) {
    const next = await nextTask(deps, runId);
    if (next.kind === "done") return deps.state.read(runId);
    if (next.kind === "finalize") {
      await finalizeRun(deps, runId);
      return deps.state.read(runId);
    }
    if (next.kind === "pause") throw new Error(`unexpected quota stop: ${next.reason}`);
    if (next.kind === "document") throw new Error("unexpected docs-ready in E2E helper");

    const taskId = next.ready[0]!; // sequential orchestrator: first ready task
    let results: DriveResults | undefined;
    for (;;) {
      const env = await nextAction(deps, runId, taskId, results);
      // Clear after delivery: the result_key gate rejects duplicate records LOUD on the
      // next nextAction call, so passing results again would be a protocol violation.
      results = undefined;
      if (env.kind === "done") break;
      if (env.kind === "pause") {
        throw new Error(`unexpected quota stop for task ${taskId}: ${env.reason}`);
      }
      // env.kind === "spawn" — the only remaining case in the discriminated union.
      results = await answer.for(env);
    }
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("runner orchestrator seam — golden contract E2E", () => {
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
    specStore = new SpecStore({ dataDir, docsRoot: join(dataDir, "_docs") });
    git = new FakeGitClient({ remoteHeads: { [`staging-${RUN_ID}`]: "sha-staging" } });
    gh = new FakeGhClient();
    holdout = new InMemoryHoldoutStore();
    artifacts = new InMemoryArtifactStore();
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Build OrchestratorDeps directly (no CLI loading — keeps the E2E free of fs config). */
  function makeDeps(request: SpecManifest, shipMode: ShipMode): OrchestratorDeps {
    return {
      config: defaultConfig(),
      spec: request,
      git,
      gh,
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
        fiveHour: { utilizationPct: 0, resetsAtEpoch: NOW + 18_000 },
        sevenDay: { utilizationPct: 0, resetsAtEpoch: NOW + 604_800 },
        capturedAt: NOW,
      }),
      now: () => NOW,
      docsApplicable: async () => false,
    };
  }

  // -------------------------------------------------------------------------
  // Scenario 1: Happy path (no-merge) — single task → completed, holdout path
  // -------------------------------------------------------------------------

  it("drives a task PRD→shipped (no-merge), holdout holdout recorded, panel all-approve", async () => {
    const request = specManifestSingle();
    await specStore.write(request, "# checkout spec\n\nvertical slice.");

    const run = await createRun(state, specStore, {
      repo: REPO,
      issue: ISSUE,
      runId: RUN_ID,
    });
    expect(run.run_id).toBe(RUN_ID);
    expect(Object.keys(run.tasks)).toEqual([TASK_ID]);
    expect(run.tasks[TASK_ID]!.status).toBe("pending");

    const deps = makeDeps(request, "no-merge");
    const answer = new AnswerBook({ holdout: { runId: RUN_ID, store: holdout } });

    // Track whether the verify spawn carried a holdout holdout (proves Δ Y path).
    // The spy wraps answer.for and is passed directly to driveToTerminal.
    let sawHoldout = false;
    // spyAnswer: plain object delegating to answer.for, recording holdout presence.
    const spyAnswer = {
      for: async (env: NextAction & { kind: "spawn" }) => {
        if (env.holdout !== undefined) sawHoldout = true;
        return answer.for(env);
      },
    };

    const finalRun = await driveToTerminal(deps, RUN_ID, spyAnswer);

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
    expect(gh.created).toHaveLength(2); // task PR + finalize rollup PR
    expect(gh.merges).toHaveLength(0);

    // The holdout path: 5-criteria spec withholds ≥1 → verify emits a holdout.
    expect(sawHoldout).toBe(true);

    // The risk-invariant panel: all six roles ran and the task reviewers were recorded.
    expect(task.reviewers).toHaveLength(PANEL_ROLES.length);
    expect(task.reviewers.every((r) => r.verdict === "approve")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Happy path (live) — same chain, PR merged
  // -------------------------------------------------------------------------

  it("serial-merges the task PR in live ship mode (same chain)", async () => {
    const request = specManifestSingle();
    await specStore.write(request, "# checkout spec\n\nvertical slice.");

    await createRun(state, specStore, {
      repo: REPO,
      issue: ISSUE,
      runId: RUN_ID,
    });

    const deps = makeDeps(request, "live");
    const answer = new AnswerBook({ holdout: { runId: RUN_ID, store: holdout } });
    const finalRun = await driveToTerminal(deps, RUN_ID, answer);

    expect(finalRun.status).toBe("completed");
    expect(finalRun.tasks[TASK_ID]!.status).toBe("done");

    // Live: the task PR was opened AND serial-merged into staging.
    // finalizeRun also opens+merges a rollup PR, so total created = 2 and merges = 2.
    const taskPrs = gh.created.filter((p) => p.head === `factory/${RUN_ID}/${TASK_ID}`);
    expect(taskPrs).toHaveLength(1);
    expect(gh.created).toHaveLength(2); // task PR + finalize rollup PR
    const prNum = finalRun.tasks[TASK_ID]!.pr_number;
    expect(gh.merges.filter((m) => m.number === prNum)).toHaveLength(1);
    expect(gh.merges).toHaveLength(2); // task PR + finalize rollup
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Drop path — capability-budget failure → failed finalize (Decision 34)
  // -------------------------------------------------------------------------

  it("fails a task at escalation cap → capability-budget → finalizeRun produces failed (Decision 34)", async () => {
    const request = specManifestTwo();
    await specStore.write(request, "# checkout spec\n\nvertical slice.");

    await createRun(state, specStore, {
      repo: REPO,
      issue: ISSUE,
      runId: RUN_ID,
    });

    // Seed t2 at ESCALATION_CAP so the first producer failure fails it.
    await state.updateTask(RUN_ID, TASK_ID_2, (t) => ({ ...t, escalation_rung: ESCALATION_CAP }));

    const deps = makeDeps(request, "no-merge");

    // t1: DONE normally. t2: deliberately unparseable producer status (no ESCALATE keyword)
    // exercises the unparseable-producer-status path; at cap → capability-budget failure.
    const answer = new AnswerBook({
      holdout: { runId: RUN_ID, store: holdout },
      producerStatuses: {
        [TASK_ID_2]: "STATUS: BLOCKED: ran out of ideas",
      },
    });

    const finalRun = await driveToTerminal(deps, RUN_ID, answer);

    // Decision 34: mixed done+failed is 'failed' (develop receives only complete PRDs).
    expect(finalRun.status).toBe("failed");

    // t1 shipped normally.
    expect(finalRun.tasks[TASK_ID]!.status).toBe("done");

    // t2 was failed as capability-budget.
    const failedTask = finalRun.tasks[TASK_ID_2]!;
    expect(failedTask.status).toBe("failed");
    expect(failedTask.failure_class).toBe("capability-budget");

    // finalizeRun posted ONE failure comment on the PRD issue (fails surfaced there,
    // not as per-task GitHub issues) naming the failed task.
    expect(gh.issueComments).toHaveLength(1);
    expect(gh.issueComments[0]!.body).toContain(TASK_ID_2);

    // Decision 34: failed run → no rollup → develop is untouched.
    const rollupPrs = gh.created.filter((p) => p.base === "develop");
    expect(rollupPrs).toHaveLength(0);
    expect(gh.merges).toHaveLength(0); // no-merge mode: no PR was auto-merged
  });
});
