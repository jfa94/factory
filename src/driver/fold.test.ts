/**
 * Fold-core semantics — moved verbatim from:
 *   - src/cli/subcommands/record-holdout.test.ts  (applyRecordHoldout describe block)
 *   - src/cli/subcommands/record-reviews.test.ts  (applyRecordReviews describe block)
 *   - src/cli/subcommands/record-producer.test.ts (applyRecordProducer describe blocks)
 *
 * Imports now point to ./fold.js; fixtures + assertions are IDENTICAL — only the
 * call sites carry the new runId argument (FoldDeps signature adjustment).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  applyRecordHoldout,
  applyRecordReviews,
  applyRecordProducer,
  type RecordReviewsInput,
  type FoldDeps,
} from "./fold.js";
import { taskWorktreePath } from "./paths.js";
import { defaultConfig } from "../config/schema.js";
import { parseSpecManifest } from "../spec/index.js";
import { StateManager } from "../core/state/manager.js";
import { FakeGitClient, FakeGhClient } from "../git/fakes.js";
import { makeFakeTools, FakeGitProbe, commit } from "../verifier/deterministic/fakes.js";
import {
  InMemoryHoldoutStore,
  InMemoryHoldoutVerdictStore,
  makeHoldoutRecord,
} from "../verifier/holdout/index.js";
import { InMemoryArtifactStore } from "./artifacts.js";
import { ESCALATION_CAP } from "../producer/index.js";
import type { TaskState } from "../types/index.js";

const RUN_ID = "run-1";
const TASK_ID = "t1";

// ---------------------------------------------------------------------------
// applyRecordHoldout fold
// ---------------------------------------------------------------------------

function holdoutSpec() {
  return parseSpecManifest({
    spec_id: "42-checkout",
    issue_number: 42,
    slug: "checkout",
    repo: "acme/widgets",
    generated_at: "2026-06-01T00:00:00.000Z",
    tasks: [
      {
        task_id: "t1",
        title: "task t1",
        description: "does t1",
        files: ["src/t1.ts"],
        acceptance_criteria: ["a", "b", "c", "d", "e"],
        tests_to_write: ["covers it"],
        depends_on: [],
        risk_tier: "medium",
        risk_rationale: "moderate",
      },
    ],
  });
}

/** Build the verdicts JSON the validator would emit for the withheld criteria. */
function validatorJson(entries: ReadonlyArray<[string, boolean, string]>): string {
  return JSON.stringify({
    criteria: entries.map(([criterion, satisfied, evidence]) => ({
      criterion,
      satisfied,
      evidence,
    })),
  });
}

describe("applyRecordHoldout fold", () => {
  let dataDir: string;
  let state: StateManager;
  let holdout: InMemoryHoldoutStore;
  let verdictStore: InMemoryHoldoutVerdictStore;
  let deps: FoldDeps;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-fold-holdout-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    holdout = new InMemoryHoldoutStore();
    verdictStore = new InMemoryHoldoutVerdictStore();
    await state.create({
      run_id: RUN_ID,
      spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
    });
    deps = {
      config: defaultConfig(),
      spec: holdoutSpec(),
      git: new FakeGitClient({ remoteHeads: { staging: "sha-staging" } }),
      gh: new FakeGhClient(),
      tools: makeFakeTools(),
      artifacts: new InMemoryArtifactStore(),
      holdout,
      dataDir,
      owner: "acme",
      repo: "widgets",
      shipMode: "no-merge",
      state,
    };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("persists the parsed verdicts and emits a PASS gate evidence when all satisfied", async () => {
    await holdout.put(RUN_ID, makeHoldoutRecord("t1", ["d", "e"], 5));
    const raw = validatorJson([
      ["d", true, "src/x.ts:10"],
      ["e", true, "src/y.ts:3"],
    ]);

    const env = await applyRecordHoldout(deps, RUN_ID, verdictStore, "t1", raw);

    expect(env.evidence.gate).toBe("holdout");
    expect(env.evidence.observed).toBe(true);
    expect(env.check.status).toBe("pass");
    expect(env.check.satisfied).toBe(2);
    expect(env.check.withheld).toBe(2);
    // The verdicts were persisted for the later record-reviews re-derivation.
    expect(await verdictStore.get(RUN_ID, "t1")).toEqual([
      { criterion: "d", satisfied: true, evidence: "src/x.ts:10" },
      { criterion: "e", satisfied: true, evidence: "src/y.ts:3" },
    ]);
  });

  it("scores a partial satisfaction below the pass rate as a FAIL", async () => {
    await holdout.put(RUN_ID, makeHoldoutRecord("t1", ["d", "e"], 5));
    const raw = validatorJson([
      ["d", true, "src/x.ts:10"],
      ["e", false, ""],
    ]);

    const env = await applyRecordHoldout(deps, RUN_ID, verdictStore, "t1", raw);

    expect(env.check.status).toBe("fail"); // 1/2 = 50% < 80%
    expect(env.evidence.observed).toBe(false);
  });

  it("fails CLOSED on unparseable validator output (verdicts → [], every criterion fails)", async () => {
    await holdout.put(RUN_ID, makeHoldoutRecord("t1", ["d", "e"], 5));

    const env = await applyRecordHoldout(deps, RUN_ID, verdictStore, "t1", "not json at all");

    expect(env.check.status).toBe("fail");
    expect(env.check.satisfied).toBe(0);
    expect(env.evidence.observed).toBe(false);
    // Even on a parse failure, an (empty) verdict array is persisted, so a later
    // record-reviews re-derivation sees the same fail-closed result.
    expect(await verdictStore.get(RUN_ID, "t1")).toEqual([]);
  });

  it("is a LOUD error when the task has no withheld answer key", async () => {
    await expect(
      applyRecordHoldout(deps, RUN_ID, verdictStore, "t1", validatorJson([])),
    ).rejects.toThrow(/no withheld answer key/);
  });
});

// ---------------------------------------------------------------------------
// applyRecordReviews fold
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

function reviewsSpec() {
  return parseSpecManifest({
    spec_id: "42-checkout",
    issue_number: 42,
    slug: "checkout",
    repo: "acme/widgets",
    generated_at: "2026-06-01T00:00:00.000Z",
    tasks: [
      {
        task_id: TASK_ID,
        title: "task t1",
        description: "does t1",
        files: ["src/t1.ts"],
        acceptance_criteria: ["a", "b", "c", "d", "e"],
        tests_to_write: ["covers it"],
        depends_on: [],
        risk_tier: "medium",
        risk_rationale: "moderate",
      },
    ],
  });
}

/** An approving review with no findings. */
function approve(reviewer: string) {
  return { reviewer, verdict: "approve" as const, findings: [] };
}

describe("applyRecordReviews fold", () => {
  let dataDir: string;
  let state: StateManager;
  let holdout: InMemoryHoldoutStore;
  let verdictStore: InMemoryHoldoutVerdictStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-fold-reviews-"));
    state = new StateManager({
      dataDir,
      lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
    });
    holdout = new InMemoryHoldoutStore();
    verdictStore = new InMemoryHoldoutVerdictStore();
    await state.create({
      run_id: RUN_ID,
      spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
    });
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: {
        [TASK_ID]: {
          task_id: TASK_ID,
          status: "reviewing",
          depends_on: [],
          risk_tier: "medium",
          escalation_rung: 0,
          reviewers: [],
          merge_resyncs: 0,
        },
      },
    }));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Build a FoldDeps over the seeded run with a GREEN gate sweep. */
  function makeDeps(): FoldDeps {
    return {
      config: defaultConfig(),
      spec: reviewsSpec(),
      git: new FakeGitClient({ remoteHeads: { staging: "sha-staging" } }),
      gh: new FakeGhClient(),
      tools: makeFakeTools({ git: greenProbe() }),
      artifacts: new InMemoryArtifactStore(),
      holdout,
      dataDir,
      owner: "acme",
      repo: "widgets",
      shipMode: "no-merge",
      state,
    };
  }

  /** Write a source file into the task worktree so a citation can verify against it. */
  async function writeWorktreeFile(relPath: string, contents: string): Promise<void> {
    const abs = join(taskWorktreePath(dataDir, RUN_ID, TASK_ID), relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }

  it("a unanimous-approve panel + green gates advances to ship", async () => {
    const deps = makeDeps();
    const input: RecordReviewsInput = {
      reviews: [approve("quality"), approve("security")],
      verifications: [],
    };

    const env = await applyRecordReviews(deps, RUN_ID, TASK_ID, verdictStore, input);

    expect(env.floor.passed).toBe(true);
    expect(env.step).toEqual({ done: false, stage: "ship" });
    const task = (await state.read(RUN_ID)).tasks[TASK_ID]!;
    expect(task.reviewers.map((r) => r.verdict)).toEqual(["approve", "approve"]);
    expect(task.status).toBe("shipping"); // markInFlight(ship)
  });

  it("a confirmed blocker blocks the floor → escalate (clear reviewers, resume at exec)", async () => {
    await writeWorktreeFile("src/x.ts", "line1\nconst x = 1\nline3\n");
    const deps = makeDeps();
    const input: RecordReviewsInput = {
      reviews: [
        approve("security"),
        {
          reviewer: "quality",
          verdict: "blocked",
          findings: [
            {
              reviewer: "quality",
              severity: "critical",
              blocking: true,
              file: "src/x.ts",
              line: 2,
              quote: "const x = 1",
              description: "magic number",
            },
          ],
        },
      ],
      // The orchestrator's independent verifier CONFIRMED the blocker.
      verifications: [
        {
          reviewer: "quality",
          verdicts: [{ file: "src/x.ts", line: 2, holds: true, note: "confirmed" }],
        },
      ],
    };

    const env = await applyRecordReviews(deps, RUN_ID, TASK_ID, verdictStore, input);

    expect(env.floor.passed).toBe(false);
    expect(env.step).toEqual({ done: false, stage: "exec" });
    // The round's reviewers are reported on the envelope (audit)…
    const quality = env.reviewers.find((r) => r.reviewer === "quality")!;
    expect(quality.verdict).toBe("blocked");
    expect(quality.confirmed_blockers).toBe(1);
    // …but state CLEARS them on escalation and bumps the rung.
    const task = (await state.read(RUN_ID)).tasks[TASK_ID]!;
    expect(task.escalation_rung).toBe(1);
    expect(task.reviewers).toEqual([]);
    expect(task.status).toBe("executing"); // cursor re-stamped at exec
  });

  it("a kept blocker with NO recorded verdict FAILS CLOSED (verifier error, never a pass)", async () => {
    await writeWorktreeFile("src/x.ts", "line1\nconst x = 1\nline3\n");
    const deps = makeDeps();
    const input: RecordReviewsInput = {
      reviews: [
        {
          reviewer: "quality",
          verdict: "blocked",
          findings: [
            {
              reviewer: "quality",
              severity: "critical",
              blocking: true,
              file: "src/x.ts",
              line: 2,
              quote: "const x = 1",
              description: "magic number",
            },
          ],
        },
      ],
      verifications: [], // no pre-recorded verdict for the kept blocker
    };

    const env = await applyRecordReviews(deps, RUN_ID, TASK_ID, verdictStore, input);

    expect(env.floor.passed).toBe(false);
    expect(env.step).toEqual({ done: false, stage: "exec" });
    // The missing verdict surfaces as a LOUD verifier error, not an auto-confirm/refute.
    expect(env.reviewers.find((r) => r.reviewer === "quality")!.verdict).toBe("error");
  });

  it("a failing holdout blocks the floor even with an approving panel + green gates", async () => {
    await holdout.put(RUN_ID, makeHoldoutRecord(TASK_ID, ["d", "e"], 5));
    // Persisted verdicts that DO NOT satisfy the withheld criteria → holdout fails.
    await verdictStore.put(RUN_ID, TASK_ID, [
      { criterion: "d", satisfied: false, evidence: "" },
      { criterion: "e", satisfied: false, evidence: "" },
    ]);
    const deps = makeDeps();
    const input: RecordReviewsInput = { reviews: [approve("quality")], verifications: [] };

    const env = await applyRecordReviews(deps, RUN_ID, TASK_ID, verdictStore, input);

    expect(env.floor.passed).toBe(false);
    expect(env.step).toEqual({ done: false, stage: "exec" });
    // The holdout gate evidence is part of the derived floor.
    expect(env.floor.from.some((e) => e.gate === "holdout" && e.observed === false)).toBe(true);
  });

  it("a satisfied holdout + approving panel + green gates advances to ship", async () => {
    await holdout.put(RUN_ID, makeHoldoutRecord(TASK_ID, ["d", "e"], 5));
    await verdictStore.put(RUN_ID, TASK_ID, [
      { criterion: "d", satisfied: true, evidence: "src/x.ts:1" },
      { criterion: "e", satisfied: true, evidence: "src/y.ts:2" },
    ]);
    const deps = makeDeps();
    const input: RecordReviewsInput = { reviews: [approve("quality")], verifications: [] };

    const env = await applyRecordReviews(deps, RUN_ID, TASK_ID, verdictStore, input);

    expect(env.floor.passed).toBe(true);
    expect(env.step).toEqual({ done: false, stage: "ship" });
    expect(env.floor.from.some((e) => e.gate === "holdout" && e.observed === true)).toBe(true);
  });

  it("is LOUD on a missing task", async () => {
    const deps = makeDeps();
    await expect(
      applyRecordReviews(deps, RUN_ID, "ghost", verdictStore, { reviews: [], verifications: [] }),
    ).rejects.toThrow(/no task 'ghost'/);
  });
});

// ---------------------------------------------------------------------------
// applyRecordProducer fold  (moved from src/cli/subcommands/record-producer.test.ts)
// ---------------------------------------------------------------------------

async function seededProducerState(
  task: Partial<TaskState> = {},
): Promise<{ dataDir: string; state: StateManager }> {
  const dataDir = await mkdtemp(join(tmpdir(), "factory-fold-producer-"));
  const state = new StateManager({
    dataDir,
    lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
  });
  await state.create({
    run_id: RUN_ID,
    spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
  });
  await state.update(RUN_ID, (s) => ({
    ...s,
    tasks: {
      t1: {
        task_id: "t1",
        status: task.status ?? "executing",
        depends_on: [],
        risk_tier: "medium",
        escalation_rung: task.escalation_rung ?? 0,
        reviewers: task.reviewers ?? [],
        merge_resyncs: 0,
      },
    },
  }));
  return { dataDir, state };
}

describe("applyRecordProducer — DONE advances", () => {
  let dataDir: string;
  let state: StateManager;
  afterEach(async () => await rm(dataDir, { recursive: true, force: true }));

  it("tests/DONE records test-writer and advances to exec", async () => {
    ({ dataDir, state } = await seededProducerState());
    const env = await applyRecordProducer(state, RUN_ID, "t1", "tests", "STATUS: DONE");

    expect(env.step).toEqual({ done: false, stage: "exec" });
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.producer_role).toBe("test-writer");
    expect(task.status).toBe("executing"); // markInFlight(exec)
  });

  it("exec/DONE records executor and advances to verify", async () => {
    ({ dataDir, state } = await seededProducerState());
    const env = await applyRecordProducer(state, RUN_ID, "t1", "exec", "STATUS: DONE");

    expect(env.step).toEqual({ done: false, stage: "verify" });
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.producer_role).toBe("executor");
    expect(task.status).toBe("reviewing"); // markInFlight(verify)
  });
});

describe("applyRecordProducer — classify-before-retry (Δ D)", () => {
  let dataDir: string;
  let state: StateManager;
  afterEach(async () => await rm(dataDir, { recursive: true, force: true }));

  it("BLOCKED—escalate drops spec-defect immediately (no rung burned)", async () => {
    ({ dataDir, state } = await seededProducerState({ escalation_rung: 0 }));
    const env = await applyRecordProducer(
      state,
      RUN_ID,
      "t1",
      "exec",
      "STATUS: BLOCKED — escalate",
    );

    expect(env.step.done).toBe(true);
    if (!env.step.done) throw new Error("unreachable");
    expect(env.step.outcome).toEqual(
      expect.objectContaining({ outcome: "dropped", failure_class: "spec-defect" }),
    );
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.status).toBe("dropped");
    expect(task.escalation_rung).toBe(0); // a drop never burns a rung
  });

  it("NEEDS_CONTEXT escalates a rung, clears reviewers, resumes at the same stage", async () => {
    ({ dataDir, state } = await seededProducerState({
      escalation_rung: 0,
      reviewers: [{ reviewer: "quality", verdict: "approve", confirmed_blockers: 0 }],
    }));
    const env = await applyRecordProducer(state, RUN_ID, "t1", "exec", "STATUS: NEEDS_CONTEXT");

    expect(env.step).toEqual({ done: false, stage: "exec" });
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.escalation_rung).toBe(1);
    expect(task.reviewers).toEqual([]); // stale reviewers cleared on escalation
    expect(task.status).toBe("executing"); // cursor re-stamped at exec
  });

  it("an unparseable status is a capability retry (error → rung bump)", async () => {
    ({ dataDir, state } = await seededProducerState({ escalation_rung: 0 }));
    const env = await applyRecordProducer(state, RUN_ID, "t1", "exec", "garbled nonsense");

    expect(env.step).toEqual({ done: false, stage: "exec" });
    expect((await state.read(RUN_ID)).tasks.t1!.escalation_rung).toBe(1);
  });

  it("an exhausted ladder drops capability-budget", async () => {
    ({ dataDir, state } = await seededProducerState({ escalation_rung: ESCALATION_CAP }));
    const env = await applyRecordProducer(state, RUN_ID, "t1", "exec", "STATUS: NEEDS_CONTEXT");

    expect(env.step.done).toBe(true);
    if (!env.step.done) throw new Error("unreachable");
    expect(env.step.outcome).toEqual(
      expect.objectContaining({ outcome: "dropped", failure_class: "capability-budget" }),
    );
    expect((await state.read(RUN_ID)).tasks.t1!.status).toBe("dropped");
  });

  it("is LOUD on a missing task", async () => {
    ({ dataDir, state } = await seededProducerState());
    await expect(
      applyRecordProducer(state, RUN_ID, "ghost", "exec", "STATUS: DONE"),
    ).rejects.toThrow(/no task 'ghost'/);
  });
});
