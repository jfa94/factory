/**
 * WS10 — unit tests for the DRIVER (the Model-A ACTOR): driveTask / driveRun /
 * Driver. These exercise what a reporter is FORBIDDEN — all StateManager writes,
 * all agent spawns (via injected runners), the per-invocation escalation ladder,
 * the loop-owned verify (gates → holdout → panel → verify-then-fix) and ship
 * (idempotent PR → serial merge), run-level finalize, quota pacing, cascade-drop,
 * and deadlock detection.
 *
 * Everything runs against a REAL StateManager (temp dir) + the exported domain
 * fakes (git/gh/gate/producer/holdout/judgment) — no real Agent(), Codex, git, or
 * gate binary. Time is frozen (NOW) so the two-window quota pacer is deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { driveTask, driveRun, Driver } from "./loop.js";
import type { DriveDeps, DriverRunners, ReviewerRunner, ShipMode } from "./types.js";
import { InMemoryArtifactStore } from "./artifacts.js";

import { defaultConfig } from "../config/schema.js";
import { parseSpecManifest } from "../spec/schema.js";
import type { SpecManifest } from "../spec/index.js";
import { StateManager } from "../core/state/manager.js";
import { FakeGitClient, FakeGhClient } from "../git/fakes.js";
import type { GhOpts } from "../git/gh-client.js";
import {
  makeFakeTools,
  FakeGitProbe,
  FakeEslint,
  proc,
  commit,
} from "../verifier/deterministic/fakes.js";
import { InMemoryHoldoutStore } from "../verifier/holdout/index.js";
import { FakeHoldoutValidatorRunner, type FakeHoldoutMode } from "../verifier/holdout/fakes.js";
import { FakeProducerAgentRunner } from "../producer/fakes.js";
import type { ProducerOutcome } from "../producer/index.js";
import { parseRawReview } from "../verifier/judgment/index.js";
import type { FindingVerifierRunner, RawReview, SourceReader } from "../verifier/judgment/index.js";
import { fakeUsageSignal, type UsageReading } from "../quota/usage-source.js";
import type { TaskState } from "../types/index.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const RUN_ID = "run-1";
/** Frozen epoch SECONDS — the unit the quota pacer windows are computed in. */
const NOW = 1_700_000_000;

const DONE: ProducerOutcome = { status: "done" };
const blockedEscalate: ProducerOutcome = {
  status: "blocked-escalate",
  reason: "spec criterion is self-contradictory",
};

/** A producer runner that always returns `done`, regardless of call count. */
function alwaysDone(): FakeProducerAgentRunner {
  return new (class extends FakeProducerAgentRunner {
    override run(spawn: Parameters<FakeProducerAgentRunner["run"]>[0]) {
      this.spawns.push(spawn);
      return Promise.resolve(DONE);
    }
  })([]);
}

/** Build a SpecManifest from task partials (sensible criteria defaults). */
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

/** A reviewer runner whose every panel member unanimously approves. */
function approveReviewer(): ReviewerRunner {
  return {
    review: ({ role }) =>
      Promise.resolve(parseRawReview({ reviewer: role, verdict: "approve", findings: [] })),
  };
}

/** Source reader (only consulted for citation-verify of real findings; none here). */
const source: SourceReader = { readLines: () => null };

/** Independent finding-verifier (identity ≠ finder; confirm unused without findings). */
function makeVerifier(review: RawReview): FindingVerifierRunner {
  return {
    identity: `verifier-for-${review.reviewer}`,
    confirm: () => Promise.resolve({ holds: true, note: "n/a" }),
  };
}

/** Build a usage reading; both windows fresh + future-reset unless overridden. */
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
const PAUSE_5H = reading({ five: 21, seven: 0 }); // hour-1 cap 20, 21 > 20 → pause
const SUSPEND_7D = reading({ five: 0, seven: 15 }); // day-1 cap 14, 15 > 14 → suspend
const UNAVAILABLE: UsageReading = { kind: "unavailable", reason: "usage-cache-missing" };

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

describe("driver loop (driveTask / driveRun)", () => {
  let dataDir: string;
  let state: StateManager;
  let holdout: InMemoryHoldoutStore;
  let artifacts: InMemoryArtifactStore;
  let git: FakeGitClient;
  let gh: FakeGhClient;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-driver-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    holdout = new InMemoryHoldoutStore();
    artifacts = new InMemoryArtifactStore();
    git = new FakeGitClient({ remoteHeads: { staging: "sha-staging" } });
    gh = new FakeGhClient();
    await state.create({
      run_id: RUN_ID,
      spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
    });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Seed task rows onto the run (schema-valid via StateManager.update). */
  async function seedTasks(tasks: ReadonlyArray<Partial<TaskState> & { task_id: string }>) {
    await state.update(RUN_ID, (s) => {
      const next = { ...s.tasks };
      for (const t of tasks) {
        next[t.task_id] = {
          task_id: t.task_id,
          status: t.status ?? "pending",
          depends_on: t.depends_on ?? [],
          risk_tier: t.risk_tier ?? "medium",
          escalation_rung: t.escalation_rung ?? 0,
          reviewers: t.reviewers ?? [],
          ...(t.failure_class ? { failure_class: t.failure_class } : {}),
          ...(t.failure_reason ? { failure_reason: t.failure_reason } : {}),
        };
      }
      return { ...s, tasks: next };
    });
  }

  /** Assemble DriveDeps from overridable parts (all-green by default). */
  function makeDeps(opts: {
    spec: SpecManifest;
    producer: FakeProducerAgentRunner;
    holdoutMode?: FakeHoldoutMode;
    usage?: UsageReading;
    shipMode?: ShipMode;
    concurrency?: number;
    tools?: DriveDeps["tools"];
    ghClient?: FakeGhClient;
    reviewer?: ReviewerRunner;
  }): DriveDeps {
    const runners: DriverRunners = {
      producer: opts.producer,
      reviewer: opts.reviewer ?? approveReviewer(),
      source,
      makeVerifier,
      holdoutValidator: new FakeHoldoutValidatorRunner(opts.holdoutMode ?? "all-pass"),
    };
    return {
      config: defaultConfig(),
      spec: opts.spec,
      git,
      gh: opts.ghClient ?? gh,
      tools: opts.tools ?? makeFakeTools({ git: greenProbe() }),
      artifacts,
      holdout,
      dataDir,
      owner: "acme",
      repo: "widgets",
      shipMode: opts.shipMode ?? "live",
      state,
      runners,
      usage: fakeUsageSignal(opts.usage ?? PROCEED),
      concurrency: opts.concurrency ?? 1,
      now: () => NOW,
    };
  }

  // -- happy path -----------------------------------------------------------

  it("drives a task preflight→…→ship→done: holdout active, gates green, live merge lands", async () => {
    const spec = makeSpec([{ task_id: "t1", acceptance_criteria: ["a", "b", "c", "d", "e"] }]);
    await seedTasks([{ task_id: "t1" }]);
    const producer = new FakeProducerAgentRunner([DONE, DONE]); // test-writer + executor
    const deps = makeDeps({ spec, producer });

    const outcome = await driveTask(deps, RUN_ID, "t1");

    expect(outcome).toEqual({ outcome: "done" });
    const run = await state.read(RUN_ID);
    expect(run.tasks.t1!.status).toBe("done");
    expect(run.tasks.t1!.pr_number).toBeDefined();
    expect(run.tasks.t1!.branch).toBe("factory/run-1/t1");
    // Producer spawned exactly twice (test-writer then executor) — no escalation.
    expect(producer.spawns.map((s) => s.role)).toEqual(["test-writer", "executor"]);
    // The PR was created once and merged once via the app-level serial writer.
    expect(gh.created).toHaveLength(1);
    expect(gh.merges).toEqual([{ number: gh.merges[0]!.number, auto: false }]);
  });

  it("no-merge ship mode opens the PR but never merges", async () => {
    const spec = makeSpec([{ task_id: "t1" }]);
    await seedTasks([{ task_id: "t1" }]);
    const deps = makeDeps({
      spec,
      producer: new FakeProducerAgentRunner([DONE, DONE]),
      shipMode: "no-merge",
    });

    const outcome = await driveTask(deps, RUN_ID, "t1");

    expect(outcome).toEqual({ outcome: "done" });
    expect(gh.created).toHaveLength(1);
    expect(gh.merges).toHaveLength(0);
  });

  it("tdd_exempt task skips the test-writer (executor is the only producer spawn)", async () => {
    const spec = makeSpec([{ task_id: "t1", tdd_exempt: true }]);
    await seedTasks([{ task_id: "t1" }]);
    const producer = new FakeProducerAgentRunner([DONE]); // executor only
    const deps = makeDeps({ spec, producer });

    const outcome = await driveTask(deps, RUN_ID, "t1");

    expect(outcome).toEqual({ outcome: "done" });
    expect(producer.spawns.map((s) => s.role)).toEqual(["executor"]);
  });

  it("a single-criterion task withholds nothing → verify skips the holdout gate", async () => {
    const spec = makeSpec([{ task_id: "t1", acceptance_criteria: ["only one"] }]);
    await seedTasks([{ task_id: "t1" }]);
    // all-fail validator would block IF consulted; a skipped holdout still ships.
    const deps = makeDeps({
      spec,
      producer: new FakeProducerAgentRunner([DONE, DONE]),
      holdoutMode: "all-fail",
    });

    const outcome = await driveTask(deps, RUN_ID, "t1");

    expect(outcome).toEqual({ outcome: "done" });
    expect(await holdout.has(RUN_ID, "t1")).toBe(false);
  });

  // -- escalation ladder ----------------------------------------------------

  it("a persistently floor-blocked task escalates the rung then drops capability-budget at the cap", async () => {
    const spec = makeSpec([{ task_id: "t1" }]);
    await seedTasks([{ task_id: "t1" }]);
    // A failing lint gate blocks the floor on every verify, regardless of approval.
    const tools = makeFakeTools({ git: greenProbe(), eslint: new FakeEslint(proc(1)) });
    // test-writer + executor(rung0) + executor(rung1) + executor(rung2) = 4 dones.
    const producer = new FakeProducerAgentRunner([DONE, DONE, DONE, DONE]);
    const deps = makeDeps({ spec, producer, tools });

    const outcome = await driveTask(deps, RUN_ID, "t1");

    expect(outcome.outcome).toBe("dropped");
    if (outcome.outcome !== "dropped") throw new Error("unreachable");
    expect(outcome.failure_class).toBe("capability-budget");
    const run = await state.read(RUN_ID);
    expect(run.tasks.t1!.status).toBe("dropped");
    expect(run.tasks.t1!.escalation_rung).toBe(2); // cap reached
    // 1 test-writer + 3 executors (rungs 0,1,2).
    expect(producer.spawns.filter((s) => s.role === "executor")).toHaveLength(3);
  });

  it("a producer blocked-escalate outcome drops immediately as spec-defect (no retry burn)", async () => {
    const spec = makeSpec([{ task_id: "t1" }]);
    await seedTasks([{ task_id: "t1" }]);
    const producer = new FakeProducerAgentRunner([blockedEscalate]); // test-writer blocks
    const deps = makeDeps({ spec, producer });

    const outcome = await driveTask(deps, RUN_ID, "t1");

    expect(outcome.outcome).toBe("dropped");
    if (outcome.outcome !== "dropped") throw new Error("unreachable");
    expect(outcome.failure_class).toBe("spec-defect");
    const run = await state.read(RUN_ID);
    expect(run.tasks.t1!.escalation_rung).toBe(0); // never escalated
    expect(producer.spawns).toHaveLength(1); // dropped on the first spawn
  });

  // -- serial-writer re-sync (live merge refusal) ---------------------------

  it("a BEHIND merge re-routes through exec to re-sync, then lands on the next attempt", async () => {
    /** A gh client that reports BEHIND on the FIRST prView, CLEAN thereafter. */
    class BehindOnceGh extends FakeGhClient {
      private views = 0;
      override async prView(n: number, fields: readonly string[], opts?: GhOpts) {
        const pr = await super.prView(n, fields, opts);
        this.views += 1;
        return this.views === 1 ? { ...pr, mergeStateStatus: "BEHIND" as const } : pr;
      }
    }
    const ghBehind = new BehindOnceGh({});
    const spec = makeSpec([{ task_id: "t1" }]);
    await seedTasks([{ task_id: "t1" }]);
    // test-writer + executor + executor(re-sync) = 3 dones.
    const producer = new FakeProducerAgentRunner([DONE, DONE, DONE]);
    const deps = makeDeps({ spec, producer, ghClient: ghBehind });

    const outcome = await driveTask(deps, RUN_ID, "t1");

    expect(outcome).toEqual({ outcome: "done" });
    expect(ghBehind.created).toHaveLength(1); // PR created once (idempotent on re-ship)
    expect(ghBehind.merges).toHaveLength(1); // merged once (the 2nd attempt)
    // The re-sync routed back through the executor (a 2nd executor spawn).
    expect(producer.spawns.filter((s) => s.role === "executor")).toHaveLength(2);
  });

  it("a permanently BEHIND merge drops blocked-environmental after the re-sync cap", async () => {
    const spec = makeSpec([{ task_id: "t1" }]);
    await seedTasks([{ task_id: "t1" }]);
    // Pre-seed an OPEN-but-BEHIND PR for the task head so every merge attempt refuses.
    const branch = "factory/run-1/t1";
    gh.setPr({
      number: 500,
      headRefName: branch,
      baseRefName: "staging",
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
      url: "https://github.com/fake/repo/pull/500",
    });
    const deps = makeDeps({ spec, producer: alwaysDone() });

    const outcome = await driveTask(deps, RUN_ID, "t1");

    expect(outcome.outcome).toBe("dropped");
    if (outcome.outcome !== "dropped") throw new Error("unreachable");
    expect(outcome.failure_class).toBe("blocked-environmental");
    expect(gh.created).toHaveLength(0); // resumed the seeded PR, never created
    expect(gh.merges).toHaveLength(0); // BEHIND never reaches prMergeSquash
  });

  // -- run-level finalize ---------------------------------------------------

  it("driveRun finalizes an all-done run as completed", async () => {
    await seedTasks([
      { task_id: "a", status: "done" },
      { task_id: "b", status: "done" },
    ]);
    const deps = makeDeps({
      spec: makeSpec([{ task_id: "a" }, { task_id: "b" }]),
      producer: alwaysDone(),
    });

    const run = await driveRun(deps, RUN_ID);
    expect(run.status).toBe("completed");
  });

  it("driveRun finalizes a mixed done/dropped run as partial", async () => {
    await seedTasks([
      { task_id: "a", status: "done" },
      {
        task_id: "b",
        status: "dropped",
        failure_class: "capability-budget",
        failure_reason: "gave up",
      },
    ]);
    const deps = makeDeps({
      spec: makeSpec([{ task_id: "a" }, { task_id: "b" }]),
      producer: alwaysDone(),
    });

    const run = await driveRun(deps, RUN_ID);
    expect(run.status).toBe("partial");
  });

  it("driveRun finalizes an empty run as failed", async () => {
    const deps = makeDeps({ spec: makeSpec([{ task_id: "a" }]), producer: alwaysDone() });
    const run = await driveRun(deps, RUN_ID);
    expect(run.status).toBe("failed");
  });

  // -- cascade-drop + deadlock ----------------------------------------------

  it("driveRun cascade-drops a task whose dependency was dropped (blocked-environmental)", async () => {
    await seedTasks([
      { task_id: "a", status: "dropped", failure_class: "spec-defect", failure_reason: "bad" },
      { task_id: "b", status: "pending", depends_on: ["a"] },
    ]);
    const deps = makeDeps({
      spec: makeSpec([{ task_id: "a" }, { task_id: "b" }]),
      producer: alwaysDone(),
    });

    const run = await driveRun(deps, RUN_ID);

    expect(run.status).toBe("failed"); // 0 done
    expect(run.tasks.b!.status).toBe("dropped");
    expect(run.tasks.b!.failure_class).toBe("blocked-environmental");
  });

  it("driveRun throws loud on a dependency cycle (no ready, no blocked) — never spins", async () => {
    await seedTasks([
      { task_id: "a", status: "pending", depends_on: ["b"] },
      { task_id: "b", status: "pending", depends_on: ["a"] },
    ]);
    const deps = makeDeps({
      spec: makeSpec([{ task_id: "a" }, { task_id: "b" }]),
      producer: alwaysDone(),
    });

    await expect(driveRun(deps, RUN_ID)).rejects.toThrow(/deadlock|cycle/i);
  });

  // -- quota gate -----------------------------------------------------------

  it("driveRun pauses in place on a 5h breach (paused, checkpoint persisted)", async () => {
    await seedTasks([{ task_id: "t1", status: "pending" }]);
    const deps = makeDeps({
      spec: makeSpec([{ task_id: "t1" }]),
      producer: alwaysDone(),
      usage: PAUSE_5H,
    });

    const run = await driveRun(deps, RUN_ID);

    expect(run.status).toBe("paused");
    expect(run.quota).toBeDefined();
    expect(run.tasks.t1!.status).toBe("pending"); // never driven
  });

  it("driveRun suspends (graceful stop) on a 7d breach", async () => {
    await seedTasks([{ task_id: "t1", status: "pending" }]);
    const deps = makeDeps({
      spec: makeSpec([{ task_id: "t1" }]),
      producer: alwaysDone(),
      usage: SUSPEND_7D,
    });

    const run = await driveRun(deps, RUN_ID);
    expect(run.status).toBe("suspended");
  });

  it("driveRun fails closed (suspended, no quota horizon) when usage is unobservable", async () => {
    await seedTasks([{ task_id: "t1", status: "pending" }]);
    const deps = makeDeps({
      spec: makeSpec([{ task_id: "t1" }]),
      producer: alwaysDone(),
      usage: UNAVAILABLE,
    });

    const run = await driveRun(deps, RUN_ID);
    expect(run.status).toBe("suspended");
    expect(run.quota).toBeUndefined();
  });

  it("driveRun resumes a paused run (clears the checkpoint) and drives it to completed", async () => {
    const spec = makeSpec([{ task_id: "t1" }]);
    await seedTasks([{ task_id: "t1", status: "pending" }]);
    await state.update(RUN_ID, (s) => ({ ...s, status: "paused" }));
    const deps = makeDeps({
      spec,
      producer: new FakeProducerAgentRunner([DONE, DONE]),
      usage: PROCEED,
    });

    const run = await driveRun(deps, RUN_ID);

    expect(run.status).toBe("completed");
    expect(run.quota).toBeUndefined(); // checkpoint cleared on resume
    expect(run.tasks.t1!.status).toBe("done");
  });

  // -- class wrapper --------------------------------------------------------

  it("the Driver class delegates to the free functions", async () => {
    const spec = makeSpec([{ task_id: "t1", tdd_exempt: true }]);
    await seedTasks([{ task_id: "t1" }]);
    const driver = new Driver(makeDeps({ spec, producer: new FakeProducerAgentRunner([DONE]) }));

    const outcome = await driver.driveTask(RUN_ID, "t1");
    expect(outcome).toEqual({ outcome: "done" });
  });
});
