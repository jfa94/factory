/**
 * WS10 — unit tests for the STAGE HANDLERS (Model-A reporters).
 *
 * These exercise each reporter in ISOLATION (no driver loop): a handler reads a
 * frozen StageContext, does deterministic work via injected clients, and RETURNS a
 * StageResult — it never writes run state and never spawns. We drive the handlers
 * with the exported domain fakes (git/gh/gate/holdout) + a real StateManager (temp
 * dir) used ONLY to mint schema-valid RunState/TaskState contexts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeStageHandlers, specTaskOf, shipBody } from "./handlers.js";
import { taskWorktreePath } from "./paths.js";
import { InMemoryArtifactStore } from "./artifacts.js";
import type { HandlerDeps, ShipMode } from "./types.js";

import { defaultConfig } from "../config/schema.js";
import { parseSpecManifest } from "../spec/schema.js";
import type { SpecManifest } from "../spec/index.js";
import { StateManager } from "../core/state/manager.js";
import { FakeGitClient, FakeGhClient } from "../git/fakes.js";
import {
  makeFakeTools,
  FakeGitProbe,
  FakeEslint,
  proc,
  commit,
} from "../verifier/deterministic/fakes.js";
import { InMemoryHoldoutStore } from "../verifier/holdout/index.js";
import { dialForRung } from "../producer/index.js";
import { PANEL_ROLES } from "../verifier/judgment/index.js";
import type { ReviewerResult, StageContext, TaskState } from "../types/index.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const RUN_ID = "run-1";

/** A spec with three shaped tasks: holdout-active, holdout-skip, tdd-exempt. */
function makeSpec(): SpecManifest {
  return parseSpecManifest({
    spec_id: "42-checkout",
    issue_number: 42,
    slug: "checkout",
    repo: "acme/widgets",
    generated_at: "2026-06-01T00:00:00.000Z",
    tasks: [
      {
        task_id: "t-multi",
        title: "multi-criteria task",
        description: "holdout is active (>=2 criteria)",
        files: ["src/multi.ts"],
        acceptance_criteria: ["a", "b", "c", "d", "e"],
        tests_to_write: ["covers a..e"],
        depends_on: [],
        risk_tier: "medium",
        risk_rationale: "moderate blast radius",
      },
      {
        task_id: "t-single",
        title: "single-criterion task",
        description: "holdout is skipped (1 criterion)",
        files: ["src/single.ts"],
        acceptance_criteria: ["only one"],
        tests_to_write: ["covers the one"],
        depends_on: [],
        risk_tier: "low",
        risk_rationale: "tiny change",
      },
      {
        task_id: "t-exempt",
        title: "tdd-exempt task",
        description: "skips the test-writer",
        files: ["src/exempt.ts"],
        acceptance_criteria: ["x", "y", "z"],
        tests_to_write: ["covers x..z"],
        depends_on: [],
        risk_tier: "high",
        risk_rationale: "exotic runner",
        tdd_exempt: true,
      },
    ],
  });
}

/** A git probe whose full default gate sweep is GREEN (TDD-valid history). */
function greenProbe(): FakeGitProbe {
  return new FakeGitProbe({
    // The verify gate passes baseRef: "staging-run-1" (the per-run branch), so
    // the TDD strategy resolves "origin/staging-run-1".
    refs: { "origin/staging-run-1": "sha-base", HEAD: "sha-head" },
    changedFiles: [],
    commits: [
      commit({ sha: "c1", files: ["src/x.test.ts"], tagged: true }),
      commit({ sha: "c2", files: ["src/x.ts"], tagged: true }),
    ],
  });
}

describe("makeStageHandlers (Model-A reporters)", () => {
  let dataDir: string;
  let state: StateManager;
  let holdout: InMemoryHoldoutStore;
  let artifacts: InMemoryArtifactStore;
  let git: FakeGitClient;
  let gh: FakeGhClient;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-handlers-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    holdout = new InMemoryHoldoutStore();
    artifacts = new InMemoryArtifactStore();
    git = new FakeGitClient({ remoteHeads: { "staging-run-1": "sha-staging" } });
    gh = new FakeGhClient();
    await state.create({
      run_id: RUN_ID,
      spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
    });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Seed a single task and return the frozen StageContext the engine would hand a reporter. */
  async function ctxFor(task: Partial<TaskState> & { task_id: string }): Promise<StageContext> {
    const full: TaskState = {
      task_id: task.task_id,
      status: task.status ?? "pending",
      depends_on: task.depends_on ?? [],
      risk_tier: task.risk_tier ?? "medium",
      escalation_rung: task.escalation_rung ?? 0,
      reviewers: task.reviewers ?? [],
      merge_resyncs: task.merge_resyncs ?? 0,
    };
    await state.update(RUN_ID, (s) => ({ ...s, tasks: { ...s.tasks, [full.task_id]: full } }));
    const run = await state.read(RUN_ID);
    const stored = run.tasks[full.task_id]!;
    return { run, task: stored, attempt: stored.escalation_rung + 1 };
  }

  function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
    return {
      config: defaultConfig(),
      spec: makeSpec(),
      git,
      gh,
      tools: makeFakeTools({ git: greenProbe() }),
      artifacts,
      holdout,
      dataDir,
      owner: "acme",
      repo: "widgets",
      shipMode: "live" as ShipMode,
      ...overrides,
    };
  }

  // -- preflight ------------------------------------------------------------

  it("preflight creates the per-task worktree forked off staging and advances to tests", async () => {
    const handlers = makeStageHandlers(makeDeps());
    const ctx = await ctxFor({ task_id: "t-multi" });
    const result = await handlers.preflight(ctx);

    expect(result).toEqual({ kind: "advance", to: "tests" });
    const wtPath = taskWorktreePath(dataDir, RUN_ID, "t-multi");
    expect(git.worktrees.get(wtPath)).toBe("factory/run-1/t-multi");
  });

  it("preflight forks the worktree from the per-run staging branch (staging/<run-id>)", async () => {
    // Seed the per-run staging branch so revParse("origin/staging-run-1") succeeds.
    const perRunGit = new FakeGitClient({ remoteHeads: { "staging-run-1": "sha-run-staging" } });
    const handlers = makeStageHandlers(makeDeps({ git: perRunGit }));
    const ctx = await ctxFor({ task_id: "t-multi" });
    await handlers.preflight(ctx);

    const wtPath = taskWorktreePath(dataDir, RUN_ID, "t-multi");
    // The worktree add startPoint must be origin/staging/<run-id>, not origin/staging.
    expect(perRunGit.calls).toContain(
      `worktree add -b factory/run-1/t-multi ${wtPath} origin/staging-run-1`,
    );
  });

  it("preflight provisions the worktree with the configured setupCommand before advancing", async () => {
    const calls: Array<{ path: string; setupCommand?: string }> = [];
    const cfg = defaultConfig();
    const deps = makeDeps({
      config: { ...cfg, quality: { ...cfg.quality, setupCommand: "npm ci" } },
      provision: async (args) => {
        calls.push({ path: args.path, setupCommand: args.setupCommand });
      },
    });
    const handlers = makeStageHandlers(deps);
    const ctx = await ctxFor({ task_id: "t-prov" });

    const result = await handlers.preflight(ctx);

    expect(result).toEqual({ kind: "advance", to: "tests" });
    expect(calls).toEqual([
      { path: taskWorktreePath(dataDir, RUN_ID, "t-prov"), setupCommand: "npm ci" },
    ]);
  });

  it("preflight is REPLAY-SAFE: a resume after a provisioning failure re-creates and reaches provision again, not a worktree-add fatal", async () => {
    let provisionCalls = 0;
    const deps = makeDeps({
      provision: async () => {
        provisionCalls += 1;
        if (provisionCalls === 1) throw new Error("npm ci failed (simulated network blip)");
      },
    });
    const handlers = makeStageHandlers(deps);
    const ctx = await ctxFor({ task_id: "t-multi" });

    // First preflight: the worktree is created, provisioning throws → the task cursor
    // stays at preflight (the stage never advanced) with the worktree on disk.
    await expect(handlers.preflight(ctx)).rejects.toThrow(/npm ci failed/);
    const wtPath = taskWorktreePath(dataDir, RUN_ID, "t-multi");
    expect(git.worktrees.has(wtPath)).toBe(true);

    // Resume: preflight re-runs. createTaskWorktree must REUSE the existing worktree
    // (not fatal on `worktree add`), so provisioning — now succeeding — advances.
    const result = await handlers.preflight(ctx);
    expect(result).toEqual({ kind: "advance", to: "tests" });
    expect(provisionCalls).toBe(2);
  });

  // -- tests ----------------------------------------------------------------

  it("tests persists the holdout answer-key and spawns the test-writer (rung 0)", async () => {
    const deps = makeDeps();
    const handlers = makeStageHandlers(deps);
    const ctx = await ctxFor({ task_id: "t-multi", escalation_rung: 0 });
    const result = await handlers.tests(ctx);

    // 5 criteria @ 20% ⇒ exactly 1 withheld ⇒ answer-key persisted.
    expect(await holdout.has(RUN_ID, "t-multi")).toBe(true);
    const record = await holdout.get(RUN_ID, "t-multi");
    expect(record.withheld_count).toBe(1);
    expect(record.total_criteria).toBe(5);

    expect(result.kind).toBe("spawn-agents");
    if (result.kind !== "spawn-agents") throw new Error("unreachable");
    expect(result.manifest.stage_after).toBe("exec");
    expect(result.manifest.agents).toHaveLength(1);
    const agent = result.manifest.agents[0]!;
    expect(agent.role).toBe("test-writer");

    // The persisted context is built off the holdout-stripped visible criteria,
    // and the rung-0 dial injects NO prior-failure note.
    const dial = dialForRung("medium", 0, deps.config);
    expect(agent.model).toBe(dial.model);
    const persisted = await artifacts.getProducerContext(RUN_ID, agent.prompt_ref);
    expect(persisted.acceptanceCriteria).toHaveLength(4); // 5 total − 1 withheld
    expect(persisted.injectedPriorFailure).toBe(false);
  });

  it("tests on a single-criterion task withholds nothing (no answer-key) but still spawns", async () => {
    const handlers = makeStageHandlers(makeDeps());
    const ctx = await ctxFor({ task_id: "t-single" });
    const result = await handlers.tests(ctx);

    expect(await holdout.has(RUN_ID, "t-single")).toBe(false);
    expect(result.kind).toBe("spawn-agents");
  });

  it("tests skips the test-writer for a tdd_exempt task (advance straight to exec)", async () => {
    const handlers = makeStageHandlers(makeDeps());
    const ctx = await ctxFor({ task_id: "t-exempt" });
    const result = await handlers.tests(ctx);

    // The answer-key is STILL persisted (holdout is independent of TDD exemption).
    expect(await holdout.has(RUN_ID, "t-exempt")).toBe(true);
    expect(result).toEqual({ kind: "advance", to: "exec" });
  });

  it("tests re-expresses the escalated dial off the persisted rung (rung 2 injects prior-failure)", async () => {
    const deps = makeDeps();
    const handlers = makeStageHandlers(deps);
    const ctx = await ctxFor({ task_id: "t-multi", escalation_rung: 2 });
    const result = await handlers.tests(ctx);

    expect(result.kind).toBe("spawn-agents");
    if (result.kind !== "spawn-agents") throw new Error("unreachable");
    const agent = result.manifest.agents[0]!;
    const dial = dialForRung("medium", 2, deps.config);
    expect(agent.model).toBe(dial.model);
    expect(dial.injectsPriorFailure).toBe(true);
    const persisted = await artifacts.getProducerContext(RUN_ID, agent.prompt_ref);
    expect(persisted.injectedPriorFailure).toBe(true);
    expect(persisted.priorFailures.length).toBeGreaterThan(0);
  });

  // -- exec -----------------------------------------------------------------

  it("exec spawns the executor and resumes at verify", async () => {
    const handlers = makeStageHandlers(makeDeps());
    const ctx = await ctxFor({ task_id: "t-multi" });
    const result = await handlers.exec(ctx);

    expect(result.kind).toBe("spawn-agents");
    if (result.kind !== "spawn-agents") throw new Error("unreachable");
    expect(result.manifest.stage_after).toBe("verify");
    expect(result.manifest.agents[0]!.role).toBe("executor");
  });

  // -- verify (CLI single-step reporter; NO holdout) ------------------------

  it("verify with no reviewers yet spawns the full risk-invariant panel", async () => {
    const handlers = makeStageHandlers(makeDeps());
    const ctx = await ctxFor({ task_id: "t-multi", reviewers: [] });
    const result = await handlers.verify(ctx);

    expect(result.kind).toBe("spawn-agents");
    if (result.kind !== "spawn-agents") throw new Error("unreachable");
    expect(result.manifest.agents).toHaveLength(PANEL_ROLES.length);
  });

  it("verify advances to ship when gates are green and reviewers unanimously approve", async () => {
    const handlers = makeStageHandlers(makeDeps());
    const reviewers: ReviewerResult[] = [
      { reviewer: "implementation-reviewer", verdict: "approve", confirmed_blockers: 0 },
      { reviewer: "security-reviewer", verdict: "approve", confirmed_blockers: 0 },
    ];
    const ctx = await ctxFor({ task_id: "t-multi", reviewers });
    const result = await handlers.verify(ctx);

    expect(result).toEqual({ kind: "advance", to: "ship" });
  });

  it("verify blocks (wait-retry) when a deterministic gate fails despite reviewer approval", async () => {
    const deps = makeDeps({
      tools: makeFakeTools({ git: greenProbe(), eslint: new FakeEslint(proc(1)) }),
    });
    const handlers = makeStageHandlers(deps);
    const reviewers: ReviewerResult[] = [
      { reviewer: "implementation-reviewer", verdict: "approve", confirmed_blockers: 0 },
    ];
    const ctx = await ctxFor({ task_id: "t-multi", reviewers });
    const result = await handlers.verify(ctx);

    expect(result.kind).toBe("wait-retry");
    if (result.kind !== "wait-retry") throw new Error("unreachable");
    expect(result.stage).toBe("verify");
    expect(result.reason).toMatch(/lint/);
  });

  it("verify gate uses staging/<run-id> as baseRef (per-run branch, not shared staging)", async () => {
    // Probe that ONLY resolves origin/staging/<run-id>. If the handler still passes
    // origin/staging, resolveBase returns null → TDD gate fails with base_ref_not_found
    // → wait-retry (gate failure). With the correct per-run baseRef the TDD gate resolves
    // the remote and the green commit history passes → advance to ship.
    const perRunProbe = new FakeGitProbe({
      refs: { "origin/staging-run-1": "sha-run-staging", HEAD: "sha-head" },
      changedFiles: [],
      commits: [
        commit({ sha: "c1", files: ["src/x.test.ts"], tagged: true }),
        commit({ sha: "c2", files: ["src/x.ts"], tagged: true }),
      ],
    });
    const deps = makeDeps({ tools: makeFakeTools({ git: perRunProbe }) });
    const handlers = makeStageHandlers(deps);
    const reviewers: ReviewerResult[] = [
      { reviewer: "implementation-reviewer", verdict: "approve", confirmed_blockers: 0 },
      { reviewer: "security-reviewer", verdict: "approve", confirmed_blockers: 0 },
    ];
    const ctx = await ctxFor({ task_id: "t-multi", reviewers });
    const result = await handlers.verify(ctx);

    // Must advance to ship — the gate must have resolved origin/staging-run-1 as its
    // diff base, not origin/staging.
    expect(result).toEqual({ kind: "advance", to: "ship" });
  });

  // -- ship (CLI single-step reporter; idempotent PR, no merge) -------------

  it("ship opens the task PR idempotently and marks the task done", async () => {
    const handlers = makeStageHandlers(makeDeps());
    const ctx = await ctxFor({ task_id: "t-multi" });

    const first = await handlers.ship(ctx);
    expect(first).toEqual({ kind: "task-terminal", outcome: { outcome: "done" } });
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0]!.head).toBe("factory/run-1/t-multi");

    // A second ship of the same task must NOT open a duplicate PR (Δ P).
    const second = await handlers.ship(ctx);
    expect(second.kind).toBe("task-terminal");
    expect(gh.created).toHaveLength(1);
  });

  // -- finalize -------------------------------------------------------------

  it("finalize over an all-done run yields a finalize-terminal completed result", async () => {
    const handlers = makeStageHandlers(makeDeps());
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: {
        d1: {
          task_id: "d1",
          status: "done",
          depends_on: [],
          risk_tier: "low",
          escalation_rung: 0,
          reviewers: [],
          merge_resyncs: 0,
        },
      },
    }));
    const run = await state.read(RUN_ID);
    const result = await handlers.finalize({ run });
    expect(result).toEqual({ kind: "finalize-terminal", run_status: "completed" });
  });
});

// ---------------------------------------------------------------------------
// module-scope reporter helpers
// ---------------------------------------------------------------------------

describe("specTaskOf / shipBody", () => {
  it("specTaskOf resolves a present task and throws LOUD on run/spec drift", () => {
    const spec = makeSpec();
    expect(specTaskOf(spec, "t-multi").title).toBe("multi-criteria task");
    expect(() => specTaskOf(spec, "ghost")).toThrow(/drift/i);
  });

  it("shipBody embeds the task id, title, run id, and risk tier", () => {
    const spec = makeSpec();
    const body = shipBody(RUN_ID, specTaskOf(spec, "t-multi"));
    expect(body).toContain("t-multi");
    expect(body).toContain("multi-criteria task");
    expect(body).toContain(RUN_ID);
    expect(body).toContain("medium");
  });
});
