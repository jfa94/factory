/**
 * `factory record-reviews` (C5) — fold the panel + verify-then-fix verdicts into the
 * floor (Decision 26/27, Δ K/T/U/V). The CLI mirror of the loop's runVerify act.
 *
 * The fold is fully deterministic: re-run the gates, re-derive the persisted holdout
 * evidence, citation-verify the reviews against the worktree, confirm each surviving
 * blocker through the REPLAY finding-verifier (the orchestrator's pre-recorded
 * verdict), derive the floor, persist the reviewers, and act through the SHARED ladder
 * (advance→ship on a pass; classify floor-blocked → escalate-or-drop resuming at exec).
 *
 * These tests pin the load-bearing semantics with a GREEN gate sweep (so the panel +
 * holdout drive the floor): a unanimous-approve panel advances to ship; a confirmed
 * blocker blocks + escalates (clearing the stale reviewers, resuming at exec); a kept
 * blocker with NO recorded verdict FAILS CLOSED (verifier error, never an auto-pass);
 * a failing holdout blocks the floor even with an approving panel.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  recordReviewsCommand,
  applyRecordReviews,
  type RecordReviewsInput,
} from "./record-reviews.js";
import type { CliDeps } from "../wiring.js";
import { EXIT } from "../exit-codes.js";
import { defaultConfig } from "../../config/schema.js";
import { parseSpecManifest } from "../../spec/index.js";
import { StateManager } from "../../core/state/manager.js";
import { FakeGitClient, FakeGhClient } from "../../git/fakes.js";
import { makeFakeTools, FakeGitProbe, commit } from "../../verifier/deterministic/fakes.js";
import {
  InMemoryHoldoutStore,
  InMemoryHoldoutVerdictStore,
  makeHoldoutRecord,
} from "../../verifier/holdout/index.js";
import { InMemoryArtifactStore, taskWorktreePath } from "../../driver/index.js";

const RUN_ID = "run-1";
const TASK_ID = "t1";

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

function spec() {
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

describe("record-reviews arg/usage edges", () => {
  it("missing --run is a usage error", async () => {
    expect(await recordReviewsCommand.run(["--task", TASK_ID, "--input", "/x.json"])).toBe(
      EXIT.USAGE,
    );
  });
  it("missing --task is a usage error", async () => {
    expect(await recordReviewsCommand.run(["--run", RUN_ID, "--input", "/x.json"])).toBe(
      EXIT.USAGE,
    );
  });
  it("missing --input is a usage error", async () => {
    expect(await recordReviewsCommand.run(["--run", RUN_ID, "--task", TASK_ID])).toBe(EXIT.USAGE);
  });
  it("--help prints help and exits OK", async () => {
    expect(await recordReviewsCommand.run(["--help"])).toBe(EXIT.OK);
  });
});

describe("applyRecordReviews fold", () => {
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

  /** Build a CliDeps over the seeded run with a GREEN gate sweep. */
  async function makeDeps(): Promise<CliDeps> {
    const run = await state.read(RUN_ID);
    return {
      config: defaultConfig(),
      spec: spec(),
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
      run,
    };
  }

  /** Write a source file into the task worktree so a citation can verify against it. */
  async function writeWorktreeFile(relPath: string, contents: string): Promise<void> {
    const abs = join(taskWorktreePath(dataDir, RUN_ID, TASK_ID), relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents);
  }

  it("a unanimous-approve panel + green gates advances to ship", async () => {
    const deps = await makeDeps();
    const input: RecordReviewsInput = {
      reviews: [approve("quality"), approve("security")],
      verifications: [],
    };

    const env = await applyRecordReviews(deps, verdictStore, TASK_ID, input);

    expect(env.floor.passed).toBe(true);
    expect(env.step).toEqual({ done: false, stage: "ship" });
    const task = (await state.read(RUN_ID)).tasks[TASK_ID]!;
    expect(task.reviewers.map((r) => r.verdict)).toEqual(["approve", "approve"]);
    expect(task.status).toBe("shipping"); // markInFlight(ship)
  });

  it("a confirmed blocker blocks the floor → escalate (clear reviewers, resume at exec)", async () => {
    await writeWorktreeFile("src/x.ts", "line1\nconst x = 1\nline3\n");
    const deps = await makeDeps();
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

    const env = await applyRecordReviews(deps, verdictStore, TASK_ID, input);

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
    const deps = await makeDeps();
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

    const env = await applyRecordReviews(deps, verdictStore, TASK_ID, input);

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
    const deps = await makeDeps();
    const input: RecordReviewsInput = { reviews: [approve("quality")], verifications: [] };

    const env = await applyRecordReviews(deps, verdictStore, TASK_ID, input);

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
    const deps = await makeDeps();
    const input: RecordReviewsInput = { reviews: [approve("quality")], verifications: [] };

    const env = await applyRecordReviews(deps, verdictStore, TASK_ID, input);

    expect(env.floor.passed).toBe(true);
    expect(env.step).toEqual({ done: false, stage: "ship" });
    expect(env.floor.from.some((e) => e.gate === "holdout" && e.observed === true)).toBe(true);
  });

  it("is LOUD on a missing task", async () => {
    const deps = await makeDeps();
    await expect(
      applyRecordReviews(deps, verdictStore, "ghost", { reviews: [], verifications: [] }),
    ).rejects.toThrow(/no task 'ghost'/);
  });
});
