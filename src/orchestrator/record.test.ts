/**
 * Record-core semantics — moved verbatim from:
 *   - src/cli/subcommands/record-holdout.test.ts  (applyRecordHoldout describe block)
 *   - src/cli/subcommands/record-reviews.test.ts  (applyRecordReviews describe block)
 *   - src/cli/subcommands/record-producer.test.ts (applyRecordProducer describe blocks)
 *
 * Imports now point to ./record.js; fixtures + assertions are IDENTICAL — only the
 * call sites carry the new runId argument (RecordDeps signature adjustment).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  applyRecordHoldout,
  applyRecordReviews,
  applyRecordProducer,
  buildWorktreeSource,
  type RecordReviewsInput,
  type RecordDeps,
} from "./record.js";
import type { RawReview } from "../verifier/judgment/index.js";
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
import { captureStream } from "../cli/test-helpers.js";
import type { TaskState } from "../types/index.js";

const RUN_ID = "run-1";
const TASK_ID = "t1";

// ---------------------------------------------------------------------------
// applyRecordHoldout record
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

describe("applyRecordHoldout record", () => {
  let dataDir: string;
  let state: StateManager;
  let holdout: InMemoryHoldoutStore;
  let verdictStore: InMemoryHoldoutVerdictStore;
  let deps: RecordDeps;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-record-holdout-"));
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

    const env = await applyRecordHoldout(deps, RUN_ID, "t1", verdictStore, raw);

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

    const env = await applyRecordHoldout(deps, RUN_ID, "t1", verdictStore, raw);

    expect(env.check.status).toBe("fail"); // 1/2 = 50% < 80%
    expect(env.evidence.observed).toBe(false);
  });

  it("fails CLOSED on unparseable validator output (verdicts → [], every criterion fails)", async () => {
    await holdout.put(RUN_ID, makeHoldoutRecord("t1", ["d", "e"], 5));

    const env = await applyRecordHoldout(deps, RUN_ID, "t1", verdictStore, "not json at all");

    expect(env.check.status).toBe("fail");
    expect(env.check.satisfied).toBe(0);
    expect(env.evidence.observed).toBe(false);
    // Even on a parse failure, an (empty) verdict array is persisted, so a later
    // record-reviews re-derivation sees the same fail-closed result.
    expect(await verdictStore.get(RUN_ID, "t1")).toEqual([]);
  });

  it("is a LOUD error when the task has no withheld answer key", async () => {
    await expect(
      applyRecordHoldout(deps, RUN_ID, "t1", verdictStore, validatorJson([])),
    ).rejects.toThrow(/no withheld answer key/);
  });
});

// ---------------------------------------------------------------------------
// applyRecordReviews record
// ---------------------------------------------------------------------------

/** A git probe whose full default gate sweep is GREEN (TDD test→impl history). */
function greenProbe(): FakeGitProbe {
  return new FakeGitProbe({
    // Seed origin/staging-run-1 (the per-run branch for RUN_ID="run-1") so the
    // TDD strategy resolves origin/${runStagingBranch("run-1")} after the fix.
    refs: { "origin/staging-run-1": "sha-base", HEAD: "sha-head" },
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

describe("applyRecordReviews record", () => {
  let dataDir: string;
  let state: StateManager;
  let holdout: InMemoryHoldoutStore;
  let verdictStore: InMemoryHoldoutVerdictStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "factory-record-reviews-"));
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

  /** Build a RecordDeps over the seeded run with a GREEN gate sweep. */
  function makeDeps(): RecordDeps {
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

  /**
   * Run `fn` while capturing stderr with warn-level logging forced ON, so the
   * "is it LOUD?" assertions are independent of any ambient FACTORY_QUIET /
   * FACTORY_LOG_LEVEL in the caller's shell. Restores both on exit.
   */
  async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
    const savedLevel = process.env["FACTORY_LOG_LEVEL"];
    const savedQuiet = process.env["FACTORY_QUIET"];
    process.env["FACTORY_LOG_LEVEL"] = "info";
    delete process.env["FACTORY_QUIET"];
    const cap = captureStream(process.stderr);
    try {
      const result = await fn();
      return { result, stderr: cap.read() };
    } finally {
      cap.restore();
      if (savedLevel === undefined) delete process.env["FACTORY_LOG_LEVEL"];
      else process.env["FACTORY_LOG_LEVEL"] = savedLevel;
      if (savedQuiet === undefined) delete process.env["FACTORY_QUIET"];
      else process.env["FACTORY_QUIET"] = savedQuiet;
    }
  }

  it("a unanimous-approve panel + green gates advances to ship", async () => {
    const deps = makeDeps();
    const input: RecordReviewsInput = {
      reviews: [approve("quality"), approve("security")],
      verifications: [],
    };

    const env = await applyRecordReviews(deps, RUN_ID, TASK_ID, verdictStore, input);

    expect(env.mergeGate.passed).toBe(true);
    expect(env.step).toEqual({ done: false, phase: "ship" });
    const task = (await state.read(RUN_ID)).tasks[TASK_ID]!;
    expect(task.reviewers.map((r) => r.verdict)).toEqual(["approve", "approve"]);
    expect(task.status).toBe("shipping"); // markInFlight(ship)
  });

  it("a confirmed blocker blocks the merge gate → escalate (clear reviewers, resume at exec)", async () => {
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
      // The runner's independent verifier CONFIRMED the blocker.
      verifications: [
        {
          reviewer: "quality",
          verdicts: [{ file: "src/x.ts", line: 2, holds: true, note: "confirmed" }],
        },
      ],
    };

    const env = await applyRecordReviews(deps, RUN_ID, TASK_ID, verdictStore, input);

    expect(env.mergeGate.passed).toBe(false);
    expect(env.step).toEqual({ done: false, phase: "exec" });
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

    expect(env.mergeGate.passed).toBe(false);
    expect(env.step).toEqual({ done: false, phase: "exec" });
    // The missing verdict surfaces as a LOUD verifier error, not an auto-confirm/refute.
    expect(env.reviewers.find((r) => r.reviewer === "quality")!.verdict).toBe("error");
  });

  it("a failing holdout blocks the merge gate even with an approving panel + green gates", async () => {
    await holdout.put(RUN_ID, makeHoldoutRecord(TASK_ID, ["d", "e"], 5));
    // Persisted verdicts that DO NOT satisfy the withheld criteria → holdout fails.
    await verdictStore.put(RUN_ID, TASK_ID, [
      { criterion: "d", satisfied: false, evidence: "" },
      { criterion: "e", satisfied: false, evidence: "" },
    ]);
    const deps = makeDeps();
    const input: RecordReviewsInput = { reviews: [approve("quality")], verifications: [] };

    const env = await applyRecordReviews(deps, RUN_ID, TASK_ID, verdictStore, input);

    expect(env.mergeGate.passed).toBe(false);
    expect(env.step).toEqual({ done: false, phase: "exec" });
    // The holdout gate evidence is part of the derived merge gate.
    expect(env.mergeGate.from.some((e) => e.gate === "holdout" && e.observed === false)).toBe(true);
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

    expect(env.mergeGate.passed).toBe(true);
    expect(env.step).toEqual({ done: false, phase: "ship" });
    expect(env.mergeGate.from.some((e) => e.gate === "holdout" && e.observed === true)).toBe(true);
  });

  it("is LOUD on a missing task", async () => {
    const deps = makeDeps();
    await expect(
      applyRecordReviews(deps, RUN_ID, "ghost", verdictStore, { reviews: [], verifications: [] }),
    ).rejects.toThrow(/no task 'ghost'/);
  });

  it("fail-closed: escalate path does NOT persist reviewers; approve path persists reviewers+phase atomically", async () => {
    // ESCALATE branch: confirmed blocker → merge gate fails → escalateOrFail path.
    // Simulating the crash window: if reviewers were written before the panel result
    // was acted on, a no-results re-invoke at verify could derive a merge gate pass without
    // holdout evidence.  With the fix, reviewers must be EMPTY after the escalate record.
    await writeWorktreeFile("src/x.ts", "line1\nconst x = 1\nline3\n");
    const depsEscalate = makeDeps();
    const escalateInput: RecordReviewsInput = {
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
      verifications: [
        {
          reviewer: "quality",
          verdicts: [{ file: "src/x.ts", line: 2, holds: true, note: "confirmed" }],
        },
      ],
    };
    const escalateEnv = await applyRecordReviews(
      depsEscalate,
      RUN_ID,
      TASK_ID,
      verdictStore,
      escalateInput,
    );
    expect(escalateEnv.mergeGate.passed).toBe(false);
    // After escalate record: task.reviewers must be empty (fail-closed — no phantom persist).
    const taskAfterEscalate = (await state.read(RUN_ID)).tasks[TASK_ID]!;
    expect(taskAfterEscalate.reviewers).toEqual([]);

    // ADVANCE branch: unanimous approve → reviewers + phase cursor land in one write.
    // Reset rung so we can run the approve case on the same seeded run.
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: {
        [TASK_ID]: {
          ...s.tasks[TASK_ID]!,
          status: "reviewing" as const,
          phase: "verify" as const,
          escalation_rung: 0,
          reviewers: [],
        },
      },
    }));
    const depsApprove = makeDeps();
    const approveInput: RecordReviewsInput = {
      reviews: [approve("quality"), approve("security")],
      verifications: [],
    };
    const approveEnv = await applyRecordReviews(
      depsApprove,
      RUN_ID,
      TASK_ID,
      verdictStore,
      approveInput,
    );
    expect(approveEnv.mergeGate.passed).toBe(true);
    expect(approveEnv.step).toEqual({ done: false, phase: "ship" });
    // After advance record: reviewers persisted + phase advanced atomically.
    const taskAfterApprove = (await state.read(RUN_ID)).tasks[TASK_ID]!;
    expect(taskAfterApprove.reviewers.map((r) => r.verdict)).toEqual(["approve", "approve"]);
    expect(taskAfterApprove.phase).toBe("ship");
    expect(taskAfterApprove.status).toBe("shipping");
  });

  it("rejects LOUD on a malformed review[0] before any gate re-run executes", async () => {
    // Wrap the git probe so we can detect if GateRunner.run() was entered
    // (it calls tools.git.treeSha as its very first operation).
    let gateRan = false;
    const baseProbe = greenProbe();
    const spyProbe: FakeGitProbe = Object.assign(Object.create(Object.getPrototypeOf(baseProbe)), {
      ...baseProbe,
      treeSha: async (...args: Parameters<typeof baseProbe.treeSha>) => {
        gateRan = true;
        return baseProbe.treeSha(...args);
      },
      refExists: baseProbe.refExists.bind(baseProbe),
      revParse: baseProbe.revParse.bind(baseProbe),
      changedFiles: baseProbe.changedFiles.bind(baseProbe),
      commits: baseProbe.commits.bind(baseProbe),
    });

    const deps: RecordDeps = {
      config: defaultConfig(),
      spec: reviewsSpec(),
      git: new FakeGitClient({ remoteHeads: { staging: "sha-staging" } }),
      gh: new FakeGhClient(),
      tools: makeFakeTools({ git: spyProbe }),
      artifacts: new InMemoryArtifactStore(),
      holdout,
      dataDir,
      owner: "acme",
      repo: "widgets",
      shipMode: "no-merge",
      state,
    };

    // A malformed review: missing required `reviewer` field so parseRawReview throws.
    const malformedReview = { verdict: "approve", findings: [] };
    const input: RecordReviewsInput = {
      reviews: [malformedReview],
      verifications: [],
    };

    await expect(applyRecordReviews(deps, RUN_ID, TASK_ID, verdictStore, input)).rejects.toThrow();
    expect(gateRan).toBe(false);
  });

  it("surfaces a cross-vendor ABSENCE on the envelope and LOUDLY warns (Δ U — never silently dropped)", async () => {
    const deps = makeDeps();
    const input: RecordReviewsInput = {
      reviews: [approve("quality"), approve("security")],
      verifications: [],
      crossVendorAbsent: { reason: "single-vendor v1 (no second vendor configured)" },
    };

    const { result: env, stderr } = await captureWarnings(() =>
      applyRecordReviews(deps, RUN_ID, TASK_ID, verdictStore, input),
    );

    // Machine-checkable: the absence rides the envelope (audit), surfaced from runPanel.
    expect(env.crossVendorAbsence).toEqual({
      reason: "single-vendor v1 (no second vendor configured)",
    });
    // The merge gate is unaffected — a second vendor is a STRENGTH signal, never a gate.
    expect(env.mergeGate.passed).toBe(true);
    expect(env.step).toEqual({ done: false, phase: "ship" });
    // LOUD: a warn line names the absence so it can never be silently swallowed.
    expect(stderr).toMatch(/cross-vendor/i);
    expect(stderr).toContain("single-vendor v1 (no second vendor configured)");
  });

  it("records NO cross-vendor absence (and emits no warn) when a second vendor was present", async () => {
    const deps = makeDeps();
    const input: RecordReviewsInput = {
      reviews: [approve("quality"), approve("security")],
      verifications: [],
    };

    const { result: env, stderr } = await captureWarnings(() =>
      applyRecordReviews(deps, RUN_ID, TASK_ID, verdictStore, input),
    );

    expect(env.crossVendorAbsence).toBeUndefined();
    expect(stderr).not.toMatch(/cross-vendor/i);
  });

  it("gate baseRef is per-run staging/<run-id>, not shared staging (Decision 33)", async () => {
    // Probe seeded with ONLY origin/staging/<run-id>. If the record still passes
    // deps.config.git.stagingBranch ("staging") as baseRef, the TDD strategy will
    // look up origin/staging (missing) → gate fails → merge gate blocks → step !== ship.
    // After the fix (runStagingBranch(runId)), the probe resolves origin/staging-run-1
    // and the green gate + approve panel advance to ship.
    const perRunProbe = new FakeGitProbe({
      refs: { "origin/staging-run-1": "sha-base", HEAD: "sha-head" },
      changedFiles: [],
      commits: [
        commit({ sha: "c1", files: ["src/x.test.ts"], tagged: true }),
        commit({ sha: "c2", files: ["src/x.ts"], tagged: true }),
      ],
    });
    const deps: RecordDeps = {
      config: defaultConfig(),
      spec: reviewsSpec(),
      git: new FakeGitClient({ remoteHeads: { "staging-run-1": "sha-staging" } }),
      gh: new FakeGhClient(),
      tools: makeFakeTools({ git: perRunProbe }),
      artifacts: new InMemoryArtifactStore(),
      holdout,
      dataDir,
      owner: "acme",
      repo: "widgets",
      shipMode: "no-merge",
      state,
    };
    const input: RecordReviewsInput = {
      reviews: [approve("quality"), approve("security")],
      verifications: [],
    };

    const env = await applyRecordReviews(deps, RUN_ID, TASK_ID, verdictStore, input);

    // Gate must be GREEN (per-run ref resolved) and merge gate must pass → advance to ship.
    expect(env.mergeGate.passed).toBe(true);
    expect(env.step).toEqual({ done: false, phase: "ship" });
  });
});

// ---------------------------------------------------------------------------
// applyRecordProducer record  (moved from src/cli/subcommands/record-producer.test.ts)
// ---------------------------------------------------------------------------

async function seededProducerState(
  task: Partial<TaskState> = {},
): Promise<{ dataDir: string; state: StateManager }> {
  const dataDir = await mkdtemp(join(tmpdir(), "factory-record-producer-"));
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

  beforeEach(async () => {
    ({ dataDir, state } = await seededProducerState());
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("tests/DONE records test-writer and advances to exec", async () => {
    const env = await applyRecordProducer(state, RUN_ID, "t1", "tests", "STATUS: DONE");

    expect(env.step).toEqual({ done: false, phase: "exec" });
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.producer_role).toBe("test-writer");
    expect(task.status).toBe("executing"); // markInFlight(exec)
  });

  it("exec/DONE records implementer and advances to verify", async () => {
    const env = await applyRecordProducer(state, RUN_ID, "t1", "exec", "STATUS: DONE");

    expect(env.step).toEqual({ done: false, phase: "verify" });
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.producer_role).toBe("implementer");
    expect(task.status).toBe("reviewing"); // markInFlight(verify)
  });
});

describe("applyRecordProducer — classify-before-retry (Δ D)", () => {
  let dataDir: string;
  let state: StateManager;

  beforeEach(async () => {
    ({ dataDir, state } = await seededProducerState());
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("BLOCKED—escalate fails spec-defect immediately (no rung burned)", async () => {
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
      expect.objectContaining({ outcome: "failed", failure_class: "spec-defect" }),
    );
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.status).toBe("failed");
    expect(task.escalation_rung).toBe(0); // a failure never burns a rung
  });

  it("NEEDS_CONTEXT escalates a rung, clears reviewers, resumes at the same phase", async () => {
    // Seed a stale reviewer the escalation should clear.
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: {
        ...s.tasks,
        t1: {
          ...s.tasks["t1"]!,
          reviewers: [{ reviewer: "quality", verdict: "approve", confirmed_blockers: 0 }],
        },
      },
    }));
    const env = await applyRecordProducer(state, RUN_ID, "t1", "exec", "STATUS: NEEDS_CONTEXT");

    expect(env.step).toEqual({ done: false, phase: "exec" });
    const task = (await state.read(RUN_ID)).tasks.t1!;
    expect(task.escalation_rung).toBe(1);
    expect(task.reviewers).toEqual([]); // stale reviewers cleared on escalation
    expect(task.status).toBe("executing"); // cursor re-stamped at exec
  });

  it("an unparseable status is a capability retry (error → rung bump)", async () => {
    const env = await applyRecordProducer(state, RUN_ID, "t1", "exec", "garbled nonsense");

    expect(env.step).toEqual({ done: false, phase: "exec" });
    expect((await state.read(RUN_ID)).tasks.t1!.escalation_rung).toBe(1);
  });

  it("an exhausted ladder fails capability-budget", async () => {
    // Advance the escalation rung to the cap so the next failure fails the task.
    await state.update(RUN_ID, (s) => ({
      ...s,
      tasks: {
        ...s.tasks,
        t1: { ...s.tasks["t1"]!, escalation_rung: ESCALATION_CAP },
      },
    }));
    const env = await applyRecordProducer(state, RUN_ID, "t1", "exec", "STATUS: NEEDS_CONTEXT");

    expect(env.step.done).toBe(true);
    if (!env.step.done) throw new Error("unreachable");
    expect(env.step.outcome).toEqual(
      expect.objectContaining({ outcome: "failed", failure_class: "capability-budget" }),
    );
    expect((await state.read(RUN_ID)).tasks.t1!.status).toBe("failed");
  });

  it("is LOUD on a missing task", async () => {
    await expect(
      applyRecordProducer(state, RUN_ID, "ghost", "exec", "STATUS: DONE"),
    ).rejects.toThrow(/no task 'ghost'/);
  });

  // Relocated from src/cli/subcommands/record-producer.test.ts (CLI shell deleted):
  // a non-producer phase must be rejected LOUD before any state read.
  it("rejects a non-producer phase (verify) LOUD", async () => {
    await expect(
      applyRecordProducer(state, RUN_ID, "t1", "verify", "STATUS: DONE"),
    ).rejects.toThrow(/producer phase \(tests \| exec\)/);
  });
});

// ---------------------------------------------------------------------------
// WS7 — buildWorktreeSource swallows ONLY ENOENT (the cited file is genuinely
// absent → null → citations unverifiable → dropped). Any OTHER read error
// (EACCES, EISDIR, I/O) is a real failure that must RETHROW, never be demoted to
// "missing" — a silent demotion would drop a citation that may back a real blocker.
// ---------------------------------------------------------------------------
describe("buildWorktreeSource — ENOENT-only swallow (citation source loader)", () => {
  let wt: string;
  beforeEach(async () => {
    wt = await mkdtemp(join(tmpdir(), "factory-record-source-"));
  });
  afterEach(async () => {
    await rm(wt, { recursive: true, force: true });
  });

  const citing = (file: string): RawReview => ({
    reviewer: "quality",
    verdict: "blocked",
    findings: [
      {
        reviewer: "quality",
        severity: "critical",
        blocking: true,
        file,
        line: 1,
        quote: "x",
        description: "d",
      },
    ],
  });

  it("a genuinely ABSENT cited file (ENOENT) maps to null — unverifiable, dropped", async () => {
    const src = await buildWorktreeSource(wt, [citing("does/not/exist.ts")]);
    expect(src.readLines("does/not/exist.ts")).toBeNull();
  });

  it("a present cited file loads its split lines", async () => {
    await writeFile(join(wt, "present.ts"), "a\nb\nc\n");
    const src = await buildWorktreeSource(wt, [citing("present.ts")]);
    expect(src.readLines("present.ts")).toEqual(["a", "b", "c", ""]);
  });

  it("a NON-ENOENT read error (cited path is a directory → EISDIR) RETHROWS — never demoted to 'missing'", async () => {
    // A real blocker citation whose file cannot be read for a reason OTHER than
    // absence must NOT be silently swallowed to null. Make the cited path a
    // directory so readFile raises EISDIR rather than ENOENT.
    await mkdir(join(wt, "a-directory"), { recursive: true });
    await expect(buildWorktreeSource(wt, [citing("a-directory")])).rejects.toThrow();
  });
});
