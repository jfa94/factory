/**
 * Golden-transcript E2E for the v1 execution model (orchestrator-as-driver, Model A).
 *
 * Every OTHER test exercises a single seam in isolation:
 *   - golden-transcript.test.ts drives the stage ENGINE over fully-fake handlers;
 *   - driver/loop.test.ts drives the IN-PROCESS driver with injected agent runners;
 *   - the subcommand tests (run-task / advance / record-*) each fold ONE step.
 *
 * Nothing chains the REAL exported CLI handler functions the way the in-session LLM
 * orchestrator does: `run create` → loop[ `run-task --stage <s>` → read the envelope's
 * `stage_result` → perform the spawn itself → fold via `advance` / `record-*` → follow
 * the returned `step.stage` ] → terminal. That envelope-chain IS the contract the
 * orchestrator SKILL relies on, so it gets its own end-to-end test here.
 *
 * The simulated orchestrator below is deliberately GENERIC — it dispatches purely on
 * `stage_result.kind` (never on a hardcoded stage list), so the asserted stage sequence
 * is genuinely produced by the handlers, not by the test. It supplies agent OUTPUTS as
 * DATA (a producer `STATUS: DONE` line, an all-pass holdout raw built from the persisted
 * answer key, six approving RawReviews) exactly as the orchestrator would after spawning
 * — the CLI path never injects runners, it consumes their text.
 *
 * Each iteration rebuilds a FRESH {@link CliDeps} from `state.read` (one real CLI
 * invocation re-reads state from disk); the external stores (git/gh/holdout/verdict/
 * artifacts) are shared instances, modelling durable resources that outlive a process.
 *
 * Two runs are proven:
 *   1. no-merge (dry-run / cutover-safety): the chain reaches `done`, the PR is opened,
 *      and it is NEVER merged.
 *   2. live: the same chain serial-merges the task PR.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportStage } from "./subcommands/run-task.js";
import { applyAdvance } from "./subcommands/advance.js";
import { applyRecordProducer } from "./subcommands/record-producer.js";
import { applyRecordHoldout } from "./subcommands/record-holdout.js";
import { applyRecordReviews, type RecordReviewsInput } from "./subcommands/record-reviews.js";
import { createRun } from "./subcommands/run.js";
import type { CliDeps } from "./wiring.js";

import { defaultConfig } from "../config/schema.js";
import { parseSpecManifest, SpecStore, type SpecManifest } from "../spec/index.js";
import { StateManager } from "../core/state/manager.js";
import { FakeGitClient, FakeGhClient } from "../git/fakes.js";
import { makeFakeTools, FakeGitProbe, commit } from "../verifier/deterministic/fakes.js";
import { InMemoryHoldoutStore, InMemoryHoldoutVerdictStore } from "../verifier/holdout/index.js";
import {
  InMemoryArtifactStore,
  type ShipMode,
  type TaskStep,
  type TaskOutcome,
} from "../driver/index.js";
import { PANEL_ROLES } from "../verifier/judgment/index.js";
import type { StageContext, TaskStage } from "../types/index.js";

const RUN_ID = "run-1";
const TASK_ID = "t1";
const REPO = "acme/widgets";
const ISSUE = 42;
const SLUG = "checkout";

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

/** One durable spec: a single task with 5 criteria (so the holdout withholds 2). */
function specManifest(): SpecManifest {
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

/** An approving review with no findings (the orchestrator's collected panel output). */
function approve(reviewer: string) {
  return { reviewer, verdict: "approve" as const, findings: [] };
}

/** What the simulated orchestrator collected by following the envelope chain. */
interface DriveTrace {
  /** Each `run-task --stage <s>` the orchestrator issued, in order. */
  readonly stagesVisited: TaskStage[];
  /** The `step.stage` each advance/record-* fold returned (non-terminal hops). */
  readonly transitionStages: TaskStage[];
  /** The terminal outcome ship surfaced. */
  terminal: TaskOutcome | null;
  /** True iff `verify` surfaced a holdout-validate sidecar. */
  sawHoldoutSidecar: boolean;
  /** True iff the orchestrator folded a holdout-validator output. */
  ranHoldoutValidate: boolean;
  /** The reviewer verdicts the panel fold derived (audit). */
  reviewerVerdicts: string[];
  /** The derived floor pass signal from the panel fold. */
  floorPassed: boolean | null;
}

describe("orchestrator-as-driver CLI envelope-chain (golden transcript)", () => {
  let dataDir: string;
  let state: StateManager;
  let specStore: SpecStore;
  let git: FakeGitClient;
  let gh: FakeGhClient;
  let holdout: InMemoryHoldoutStore;
  let verdictStore: InMemoryHoldoutVerdictStore;
  let artifacts: InMemoryArtifactStore;
  let manifest: SpecManifest;

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
    verdictStore = new InMemoryHoldoutVerdictStore();
    artifacts = new InMemoryArtifactStore();
    manifest = specManifest();
    // The durable spec the run resolves (Δ X reuse path) — written before `run create`.
    await specStore.write(manifest, "# checkout spec\n\nvertical slice.");
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Rebuild a fresh CliDeps from the persisted run — one CLI invocation's view. */
  async function freshDeps(shipMode: ShipMode): Promise<CliDeps> {
    const run = await state.read(RUN_ID);
    return {
      config: defaultConfig(),
      spec: manifest,
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
      run,
    };
  }

  function ctxFor(deps: CliDeps, taskId: string): StageContext {
    const task = deps.run.tasks[taskId];
    if (task === undefined) throw new Error(`test: task '${taskId}' missing`);
    return { run: deps.run, task, attempt: task.escalation_rung + 1 };
  }

  /** Build the all-pass holdout-validator raw output from the persisted answer key. */
  async function allPassHoldoutRaw(taskId: string): Promise<string> {
    const record = await holdout.get(RUN_ID, taskId);
    return JSON.stringify({
      criteria: record.withheld_criteria.map((criterion) => ({
        criterion,
        satisfied: true,
        evidence: "src/t1.ts:1",
      })),
    });
  }

  /** Resume target of a non-terminal step (terminal `done` ends the loop). */
  function nextOf(step: TaskStep): TaskStage | null {
    return step.done ? null : step.stage;
  }

  /**
   * Simulate the Model-A orchestrator: start at `preflight`, dispatch on the
   * envelope's `stage_result.kind`, fold each outcome via the real CLI handlers, and
   * follow the returned `step.stage` until ship is terminal. Generic — no stage is
   * hardcoded into the control flow; the sequence emerges from the handlers.
   */
  async function driveTaskViaCli(taskId: string, shipMode: ShipMode): Promise<DriveTrace> {
    const trace: DriveTrace = {
      stagesVisited: [],
      transitionStages: [],
      terminal: null,
      sawHoldoutSidecar: false,
      ranHoldoutValidate: false,
      reviewerVerdicts: [],
      floorPassed: null,
    };

    let stage: TaskStage | null = "preflight";
    let guard = 0;
    while (stage !== null) {
      if (++guard > 50) throw new Error("orchestrator loop did not terminate");
      trace.stagesVisited.push(stage);

      const deps = await freshDeps(shipMode);
      const env = await reportStage(deps, ctxFor(deps, taskId), stage, taskId);
      const result = env.stage_result;

      switch (result.kind) {
        case "advance": {
          const t = await applyAdvance(state, RUN_ID, taskId, result.to);
          trace.transitionStages.push(result.to);
          stage = nextOf(t.step);
          break;
        }
        case "spawn-agents": {
          if (stage === "tests" || stage === "exec") {
            // Producer spawn (test-writer / executor) → fold its terminal STATUS line.
            const t = await applyRecordProducer(state, RUN_ID, taskId, stage, "STATUS: DONE");
            if (!t.step.done) trace.transitionStages.push(t.step.stage);
            stage = nextOf(t.step);
          } else if (stage === "verify") {
            // Panel spawn. First fold the out-of-band holdout-validator sidecar, then
            // the six reviewers + (here empty) per-finding verifier verdicts.
            if (env.sidecar !== undefined) {
              trace.sawHoldoutSidecar = true;
              const raw = await allPassHoldoutRaw(taskId);
              await applyRecordHoldout(
                await freshDeps(shipMode),
                RUN_ID,
                verdictStore,
                taskId,
                raw,
              );
              trace.ranHoldoutValidate = true;
            }
            const input: RecordReviewsInput = {
              reviews: PANEL_ROLES.map((role) => approve(role)),
              verifications: [],
              crossVendorAbsent: { reason: "single-vendor v1 (no second vendor configured)" },
            };
            const reviewsEnv = await applyRecordReviews(
              await freshDeps(shipMode),
              RUN_ID,
              taskId,
              verdictStore,
              input,
            );
            trace.reviewerVerdicts = reviewsEnv.reviewers.map((r) => r.verdict);
            trace.floorPassed = reviewsEnv.floor.passed;
            if (!reviewsEnv.step.done) trace.transitionStages.push(reviewsEnv.step.stage);
            stage = nextOf(reviewsEnv.step);
          } else {
            throw new Error(`unexpected spawn-agents at stage '${stage}'`);
          }
          break;
        }
        case "task-terminal": {
          // ship is terminal-by-construction: no transition step, just the outcome.
          trace.terminal = result.outcome;
          stage = null;
          break;
        }
        case "wait-retry":
          throw new Error(`unexpected wait-retry on the happy path: ${result.reason}`);
        case "graceful-stop":
        case "finalize-terminal":
          throw new Error(`unexpected run-level result '${result.kind}' in a per-task drive`);
        default: {
          const _never: never = result;
          throw new Error(`unknown stage_result ${JSON.stringify(_never)}`);
        }
      }
    }
    return trace;
  }

  it("drives a task PRD→shipped through the real CLI handlers (no-merge dry-run)", async () => {
    // `run create` resolves the durable spec by stable issue number and seeds the task.
    const run = await createRun(state, specStore, {
      repo: REPO,
      issue: ISSUE,
      driver: "balanced",
      runId: RUN_ID,
    });
    expect(run.run_id).toBe(RUN_ID);
    expect(Object.keys(run.tasks)).toEqual([TASK_ID]);
    expect(run.tasks[TASK_ID]!.status).toBe("pending");

    const trace = await driveTaskViaCli(TASK_ID, "no-merge");

    // The golden stage sequence emerges from the handlers, not the test's control flow.
    expect(trace.stagesVisited).toEqual(["preflight", "tests", "exec", "verify", "ship"]);
    // Each fold's returned cursor walked the same ladder to the terminal ship.
    expect(trace.transitionStages).toEqual(["tests", "exec", "verify", "ship"]);

    // The verify round surfaced + folded the holdout answer key (Δ Y).
    expect(trace.sawHoldoutSidecar).toBe(true);
    expect(trace.ranHoldoutValidate).toBe(true);

    // The risk-invariant panel: all six roles ran and the derived floor passed.
    expect(trace.reviewerVerdicts).toEqual(PANEL_ROLES.map(() => "approve"));
    expect(trace.reviewerVerdicts).toHaveLength(6);
    expect(trace.floorPassed).toBe(true);

    // The task reached a clean terminal `done`.
    expect(trace.terminal).toEqual({ outcome: "done" });

    // Persisted state: the ship stage recorded the run-scoped branch + PR and `done`.
    const task = (await state.read(RUN_ID)).tasks[TASK_ID]!;
    expect(task.status).toBe("done");
    expect(task.branch).toBe(`factory/${RUN_ID}/${TASK_ID}`);
    expect(task.pr_number).toBeDefined();

    // Dry-run: the PR was opened but NEVER merged (the cutover-safety invariant).
    expect(gh.created).toHaveLength(1);
    expect(gh.merges).toHaveLength(0);
  });

  it("serial-merges the task PR in live ship mode (same chain)", async () => {
    await createRun(state, specStore, {
      repo: REPO,
      issue: ISSUE,
      driver: "balanced",
      runId: RUN_ID,
    });

    const trace = await driveTaskViaCli(TASK_ID, "live");

    expect(trace.stagesVisited).toEqual(["preflight", "tests", "exec", "verify", "ship"]);
    expect(trace.terminal).toEqual({ outcome: "done" });
    expect((await state.read(RUN_ID)).tasks[TASK_ID]!.status).toBe("done");

    // Live: the PR was opened AND serial-merged into staging exactly once.
    expect(gh.created).toHaveLength(1);
    expect(gh.merges).toHaveLength(1);
  });
});
