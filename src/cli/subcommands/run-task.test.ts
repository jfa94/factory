/**
 * `factory run-task` (Task C) — unit tests for the single-step reporter.
 *
 * Two surfaces:
 *   1. the arg-parse / usage edges (short-circuit BEFORE any wiring, so they need
 *      no stores) via {@link runTaskCommand};
 *   2. the per-stage dispatch + envelope shape via {@link reportStage} with a
 *      hand-wired fake {@link CliDeps} bundle (real StateManager temp dir + the
 *      exported domain fakes — no real git/gh/gate binaries).
 *
 * The report stages (preflight/tests/exec/verify) must NEVER write run state; only
 * `ship` mutates (branch/pr_number + the terminal done). `verify` must surface a
 * holdout-validate sidecar exactly when a key was withheld AND the panel spawns.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTaskCommand } from "./run-task.js";
import { reportStage } from "./run-task.js";
import type { CliDeps } from "../wiring.js";
import { EXIT } from "../exit-codes.js";

import { defaultConfig } from "../../config/schema.js";
import { parseSpecManifest, type SpecManifest } from "../../spec/index.js";
import { StateManager } from "../../core/state/manager.js";
import { FakeGitClient, FakeGhClient } from "../../git/fakes.js";
import { makeFakeTools, FakeGitProbe, commit } from "../../verifier/deterministic/fakes.js";
import { InMemoryHoldoutStore, makeHoldoutRecord } from "../../verifier/holdout/index.js";
import { InMemoryArtifactStore } from "../../driver/index.js";
import type { ShipMode } from "../../driver/index.js";
import type { StageContext, TaskState } from "../../types/index.js";

const RUN_ID = "run-1";

/** Build a SpecManifest from task partials (sensible defaults). */
function makeSpec(
  tasks: ReadonlyArray<{
    task_id: string;
    acceptance_criteria?: readonly string[];
    tdd_exempt?: boolean;
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
      depends_on: [],
      risk_tier: "medium",
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

describe("run-task arg/usage edges", () => {
  it("missing --run is a usage error", async () => {
    expect(await runTaskCommand.run(["--task", "t1", "--stage", "exec"])).toBe(EXIT.USAGE);
  });
  it("missing --task is a usage error", async () => {
    expect(await runTaskCommand.run(["--run", RUN_ID, "--stage", "exec"])).toBe(EXIT.USAGE);
  });
  it("missing --stage is a usage error", async () => {
    expect(await runTaskCommand.run(["--run", RUN_ID, "--task", "t1"])).toBe(EXIT.USAGE);
  });
  it("an unknown --stage is a usage error", async () => {
    expect(await runTaskCommand.run(["--run", RUN_ID, "--task", "t1", "--stage", "bogus"])).toBe(
      EXIT.USAGE,
    );
  });
  it("an unknown --ship-mode is a usage error", async () => {
    expect(
      await runTaskCommand.run([
        "--run",
        RUN_ID,
        "--task",
        "t1",
        "--stage",
        "ship",
        "--ship-mode",
        "auto",
      ]),
    ).toBe(EXIT.USAGE);
  });
  it("--help prints help and exits OK", async () => {
    expect(await runTaskCommand.run(["--help"])).toBe(EXIT.OK);
  });
});

describe("run-task reportStage dispatch", () => {
  let dataDir: string;
  let state: StateManager;
  let holdout: InMemoryHoldoutStore;
  let git: FakeGitClient;
  let gh: FakeGhClient;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-run-task-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    holdout = new InMemoryHoldoutStore();
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

  async function seedTask(t: Partial<TaskState> & { task_id: string }) {
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: {
        ...s.tasks,
        [t.task_id]: {
          task_id: t.task_id,
          status: t.status ?? "pending",
          depends_on: [],
          risk_tier: "medium",
          escalation_rung: t.escalation_rung ?? 0,
          reviewers: t.reviewers ?? [],
        },
      },
    }));
  }

  /** Assemble a fake CliDeps bundle (reporter seam only — no agent runners). */
  async function makeDeps(spec: SpecManifest, shipMode: ShipMode = "no-merge"): Promise<CliDeps> {
    const run = await state.read(RUN_ID);
    return {
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

  it("preflight reports advance(tests) and creates the worktree, no state write", async () => {
    await seedTask({ task_id: "t1" });
    const spec = makeSpec([{ task_id: "t1" }]);
    const deps = await makeDeps(spec);

    const env = await reportStage(deps, ctxFor(deps, "t1"), "preflight", "t1");

    expect(env.stage).toBe("preflight");
    expect(env.stage_result).toEqual({ kind: "advance", to: "tests" });
    expect(env.sidecar).toBeUndefined();
    // pure report: the persisted task is untouched (still pending, no started_at).
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.status).toBe("pending");
  });

  it("tests (non-exempt) spawns the test-writer and persists the holdout answer key", async () => {
    await seedTask({ task_id: "t1" });
    const spec = makeSpec([{ task_id: "t1", acceptance_criteria: ["a", "b", "c", "d", "e"] }]);
    const deps = await makeDeps(spec);

    const env = await reportStage(deps, ctxFor(deps, "t1"), "tests", "t1");

    expect(env.stage_result.kind).toBe("spawn-agents");
    if (env.stage_result.kind !== "spawn-agents") throw new Error("unreachable");
    expect(env.stage_result.manifest.agents[0]!.role).toBe("test-writer");
    expect(env.stage_result.manifest.stage_after).toBe("exec");
    // the answer key was withheld + persisted (the one persisting stage).
    expect(await holdout.has(RUN_ID, "t1")).toBe(true);
  });

  it("tests (tdd_exempt) advances straight to exec (no test-writer spawn)", async () => {
    await seedTask({ task_id: "t1" });
    const spec = makeSpec([{ task_id: "t1", tdd_exempt: true }]);
    const deps = await makeDeps(spec);

    const env = await reportStage(deps, ctxFor(deps, "t1"), "tests", "t1");
    expect(env.stage_result).toEqual({ kind: "advance", to: "exec" });
  });

  it("exec spawns the executor resuming at verify", async () => {
    await seedTask({ task_id: "t1" });
    const deps = await makeDeps(makeSpec([{ task_id: "t1" }]));

    const env = await reportStage(deps, ctxFor(deps, "t1"), "exec", "t1");

    expect(env.stage_result.kind).toBe("spawn-agents");
    if (env.stage_result.kind !== "spawn-agents") throw new Error("unreachable");
    expect(env.stage_result.manifest.agents[0]!.role).toBe("executor");
    expect(env.stage_result.manifest.stage_after).toBe("verify");
  });

  it("verify spawns the panel AND surfaces a holdout sidecar when a key was withheld", async () => {
    await seedTask({ task_id: "t1" });
    const spec = makeSpec([{ task_id: "t1", acceptance_criteria: ["a", "b", "c", "d", "e"] }]);
    const deps = await makeDeps(spec);
    // a withheld answer key exists (as the tests stage would have persisted).
    await holdout.put(RUN_ID, makeHoldoutRecord("t1", ["d", "e"], 5));

    const env = await reportStage(deps, ctxFor(deps, "t1"), "verify", "t1");

    expect(env.stage_result.kind).toBe("spawn-agents"); // no reviewers yet → panel
    expect(env.sidecar).toBeDefined();
    expect(env.sidecar!.kind).toBe("holdout-validate");
    expect(env.sidecar!.task_id).toBe("t1");
    // the prompt carries the withheld criteria so the orchestrator can spawn it.
    expect(env.sidecar!.prompt).toContain("d");
    expect(env.sidecar!.prompt).toContain("e");
  });

  it("verify emits NO holdout sidecar when nothing was withheld", async () => {
    await seedTask({ task_id: "t1" });
    const deps = await makeDeps(makeSpec([{ task_id: "t1" }]));
    // no holdout.put → degenerate split, no key.

    const env = await reportStage(deps, ctxFor(deps, "t1"), "verify", "t1");

    expect(env.stage_result.kind).toBe("spawn-agents");
    expect(env.sidecar).toBeUndefined();
  });

  it("ship (no-merge) opens the PR, records branch/pr_number, writes done", async () => {
    await seedTask({ task_id: "t1", status: "shipping" });
    const deps = await makeDeps(makeSpec([{ task_id: "t1" }]), "no-merge");

    const env = await reportStage(deps, ctxFor(deps, "t1"), "ship", "t1");

    expect(env.stage_result).toEqual({ kind: "task-terminal", outcome: { outcome: "done" } });
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.status).toBe("done");
    expect(task.branch).toBe("factory/run-1/t1");
    expect(task.pr_number).toBeDefined();
    expect(gh.created).toHaveLength(1);
    expect(gh.merges).toHaveLength(0); // no-merge: opened, never merged
  });

  it("ship (live) serial-merges and writes done", async () => {
    await seedTask({ task_id: "t1", status: "shipping" });
    const deps = await makeDeps(makeSpec([{ task_id: "t1" }]), "live");

    const env = await reportStage(deps, ctxFor(deps, "t1"), "ship", "t1");

    expect(env.stage_result).toEqual({ kind: "task-terminal", outcome: { outcome: "done" } });
    expect((await state.read(RUN_ID)).tasks.t1!.status).toBe("done");
    expect(gh.merges).toHaveLength(1);
  });
});
