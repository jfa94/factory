/**
 * Unit tests for nextAction — the per-task orchestrator.
 *
 * Each test gets a FRESH tmp dataDir (no shared mutable state). makeOrchestratorDeps
 * seeds the run and task state and returns deps + run-id.
 *
 * Helpers:
 *   - driveToVerify: step twice (record DONE twice) to reach the verify spawn;
 *     returns the verify spawn envelope (LOUD if not reached)
 *   - approvingReviewsResults: a DriveResults with approving reviews from all PANEL_ROLES + holdout pass
 *   - blockingReviewsResults: a DriveResults with one confirmed blocker
 *
 * result_key discipline: every helper that builds a DriveResults accepts the prior
 * spawn envelope and copies result_key verbatim — the natural orchestrator behavior.
 */
import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { nextAction, MERGE_RESYNC_CAP, type NextAction } from "./orchestrator.js";
import { TASK_PHASE_ORDER } from "../types/index.js";
import { TaskStateSchema } from "../core/state/index.js";
import type { DriveResults, ResultKey } from "./results.js";
import { SPAWN_PHASES } from "./results.js";

import { makeHoldoutRecord, FsHoldoutVerdictStore } from "../verifier/holdout/index.js";
import { taskWorktreePath } from "./paths.js";
import { PANEL_ROLES } from "../verifier/judgment/index.js";
import { ESCALATION_CAP } from "../producer/index.js";

import { makeOrchestratorDeps, PAUSE_5H } from "./orchestrator-fixtures.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import { FakeGhClient, FakeGitClient } from "../git/fakes.js";
import { runScopedBranch, runStagingBranch } from "../git/index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Drive T1 through tests+exec (record DONE twice) to land at the verify spawn.
 * Returns the verify spawn envelope (LOUD assertion — never returns non-spawn).
 * result_key is echoed from each prior envelope, matching natural orchestrator behavior.
 */
async function driveToVerify(
  deps: OrchestratorDeps,
  runId: string,
  taskId: string,
): Promise<NextAction & { kind: "spawn" }> {
  // 1. First step → tests spawn
  const env1 = await nextAction(deps, runId, taskId);
  expect(env1.kind).toBe("spawn");
  if (env1.kind !== "spawn") throw new Error("expected spawn at tests");
  expect(env1.phase).toBe("tests");

  // 2. Record DONE for tests → exec spawn (echo result_key from env1)
  const env2 = await nextAction(deps, runId, taskId, {
    result_key: env1.result_key,
    producer: { status: "STATUS: DONE" },
  });
  expect(env2.kind).toBe("spawn");
  if (env2.kind !== "spawn") throw new Error("expected spawn at exec");
  expect(env2.phase).toBe("exec");

  // 3. Record DONE for exec → verify spawn (echo result_key from env2)
  const env3 = await nextAction(deps, runId, taskId, {
    result_key: env2.result_key,
    producer: { status: "STATUS: DONE" },
  });
  // Must be a verify spawn — LOUD assertion, never silently skip.
  expect(env3.kind).toBe("spawn");
  if (env3.kind !== "spawn") throw new Error("expected verify spawn after exec DONE");
  expect(env3.phase).toBe("verify");
  return env3;
}

/**
 * Build a DriveResults with approving reviews from all PANEL_ROLES (all PANEL_ROLES) + holdout pass.
 * result_key is echoed from the prior spawn envelope.
 */
function approvingReviewsResults(
  priorEnvelope: NextAction & { kind: "spawn" },
  withheldCriteria?: readonly string[],
): DriveResults {
  const reviews = PANEL_ROLES.map((role) => ({
    reviewer: role,
    verdict: "approve" as const,
    findings: [],
  }));
  const result: DriveResults = {
    result_key: priorEnvelope.result_key,
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
 * result_key is echoed from the prior spawn envelope.
 */
function blockingReviewsResults(priorEnvelope: NextAction & { kind: "spawn" }): DriveResults {
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
    result_key: priorEnvelope.result_key,
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
// phase-cursor literals cross-module pin
// ---------------------------------------------------------------------------

describe("phase-cursor literals", () => {
  it("TaskState.phase enum equals TASK_PHASE_ORDER (cross-module pin)", () => {
    const phaseField = TaskStateSchema.shape.phase;
    // phase is z.enum([...]).optional() — unwrap once to get the ZodEnum
    const phaseEnum = phaseField.unwrap();
    expect(phaseEnum.options).toEqual([...TASK_PHASE_ORDER]);
  });

  it("TaskState.spawn_in_flight.phase enum equals SPAWN_PHASES (cross-module pin)", () => {
    // The checkpoint's phase literal is duplicated in core/state (it must not import
    // the orchestrator), so pin it equal to orchestrator/results' SPAWN_PHASES source of truth —
    // a drift here would let the orchestrator persist a checkpoint the schema rejects.
    const sif = TaskStateSchema.shape.spawn_in_flight;
    const phaseEnum = sif.unwrap().shape.phase; // z.object({...}).optional() → object → .phase
    expect(phaseEnum.options).toEqual([...SPAWN_PHASES]);
  });
});

// ---------------------------------------------------------------------------
// nextAction
// ---------------------------------------------------------------------------

describe("nextAction", () => {
  it("fresh task steps preflight deterministically and stops at the tests spawn", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      const env = await nextAction(deps, runId, "T1");
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.phase).toBe("tests");
      expect(env.expects).toBe("producer-status");
      expect(env.request.agents[0]?.role).toBe("test-writer");
      expect(env.result_key).toEqual({ phase: "tests", rung: 0 });
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.phase).toBe("tests"); // cursor persisted
    } finally {
      await cleanup();
    }
  });

  it("re-invoking without results re-emits the same spawn envelope (idempotent)", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      const a = await nextAction(deps, runId, "T1");
      expect(a.kind).toBe("spawn");
      const b = await nextAction(deps, runId, "T1");
      expect(b).toEqual(a);
    } finally {
      await cleanup();
    }
  });

  it("re-invoking at verify without results re-emits the same verify spawn (idempotent)", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c", "d", "e"] }],
    });
    try {
      const verifyEnv = await driveToVerify(deps, runId, "T1");
      // Two consecutive no-results steps at verify must deep-equal the prior envelope.
      const a = await nextAction(deps, runId, "T1");
      expect(a.kind).toBe("spawn");
      const b = await nextAction(deps, runId, "T1");
      expect(b).toEqual(a);
      expect(a).toEqual(verifyEnv);
    } finally {
      await cleanup();
    }
  });

  // -- WS2: stop-mid-spawn idempotent re-spawn --------------------------------
  // Producers commit to the SHARED task worktree (isolation omitted), so a stop in
  // the post-spawn / pre-record window leaves the abandoned producer's partial commits
  // on the task branch. The orchestrator captures the pre-spawn tip at emit and, on a
  // resume that re-enters the SAME (phase, rung), resets the worktree to it.

  it("captures the pre-spawn tip on a fresh spawn and does not reset the worktree (WS2)", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      const git = deps.git as FakeGitClient;
      const env1 = await nextAction(deps, runId, "T1"); // fresh tests spawn
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;

      // A fresh spawn never resets (nothing abandoned yet)...
      expect(git.calls.filter((c) => c.startsWith("reset --hard"))).toEqual([]);
      // ...but it DOES persist the checkpoint naming this exact spawn + the pre-spawn tip.
      const taskBranch = runScopedBranch(runId, "T1");
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.spawn_in_flight).toEqual({
        phase: "tests",
        rung: 0,
        tip_sha: git.localBranches.get(taskBranch),
      });
    } finally {
      await cleanup();
    }
  });

  it("resets the task worktree to the pre-spawn tip when re-emitting an abandoned spawn (WS2)", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      const git = deps.git as FakeGitClient;
      const taskBranch = runScopedBranch(runId, "T1");

      // 1. First step → tests spawn; the orchestrator captures the pre-spawn task-branch tip.
      const env1 = await nextAction(deps, runId, "T1");
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;
      const preSpawnTip = git.localBranches.get(taskBranch);
      expect(preSpawnTip).toBeDefined();

      // 2. Simulate the test-writer committing partial work to the shared task worktree,
      //    then a STOP before any results were recorded (advance the task-branch tip).
      git.localBranches.set(taskBranch, "sha-abandoned-partial");

      // 3. Resume WITHOUT results → re-emit the SAME spawn AND discard the partial work
      //    by resetting the worktree to the captured pre-spawn tip.
      const callsBefore = git.calls.length;
      const env2 = await nextAction(deps, runId, "T1");
      expect(env2).toEqual(env1); // identical spawn envelope (idempotent re-emit)

      const resetCalls = git.calls.slice(callsBefore).filter((c) => c.startsWith("reset --hard"));
      expect(resetCalls).toEqual([`reset --hard ${preSpawnTip}`]);
      // The abandoned partial commit is gone — worktree restored to the pre-spawn tip.
      expect(git.localBranches.get(taskBranch)).toBe(preSpawnTip);
    } finally {
      await cleanup();
    }
  });

  it("advancing phases overwrites the checkpoint so a stale prior-phase entry never resets (WS2)", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      const git = deps.git as FakeGitClient;
      const env1 = await nextAction(deps, runId, "T1"); // tests spawn → checkpoint {tests,0}
      if (env1.kind !== "spawn") throw new Error("expected tests spawn");

      // Record tests DONE → exec spawn. The advance changes the phase, so this is a FRESH
      // spawn that OVERWRITES the checkpoint (never a reset against the stale tests entry).
      const callsBefore = git.calls.length;
      const env2 = await nextAction(deps, runId, "T1", {
        result_key: env1.result_key,
        producer: { status: "STATUS: DONE" },
      });
      if (env2.kind !== "spawn") throw new Error("expected exec spawn");
      expect(env2.phase).toBe("exec");
      expect(git.calls.slice(callsBefore).filter((c) => c.startsWith("reset --hard"))).toEqual([]);
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.spawn_in_flight).toEqual({
        phase: "exec",
        rung: 0,
        tip_sha: git.localBranches.get(runScopedBranch(runId, "T1")),
      });
    } finally {
      await cleanup();
    }
  });

  it("records a producer DONE and advances to the exec spawn", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      const env1 = await nextAction(deps, runId, "T1"); // → tests spawn
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;
      const env = await nextAction(deps, runId, "T1", {
        result_key: env1.result_key,
        producer: { status: "STATUS: DONE" },
      });
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.phase).toBe("exec");
      expect(env.request.agents[0]?.role).toBe("implementer");
    } finally {
      await cleanup();
    }
  });

  // De-duplication pin (Task 4.1 Step 2b): one record cycle that resumes at a phase
  // must write that phase's cursor EXACTLY ONCE. Before the fix the record's
  // persistStepCursor wrote the cursor and the orchestrator loop's first markInFlight wrote
  // the IDENTICAL cursor again (2 locked RMW + fsync per record). A counting wrapper
  // over updateTask tallies writes that set the resumed cursor (phase "exec").
  it("recording a producer DONE writes the resumed exec cursor exactly once (no duplicate RMW)", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      const env1 = await nextAction(deps, runId, "T1"); // → tests spawn
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;

      // Wrap updateTask to count CURSOR writes that land on the exec cursor. A cursor
      // write (persistStepCursor / markInFlight) only sets phase+status, leaving
      // spawn_in_flight untouched (spread `...t`, same reference); the WS2 capture write
      // REPLACES spawn_in_flight with a fresh object. Counting only writes that preserve
      // the spawn_in_flight reference isolates the cursor RMW this test guards — and still
      // catches the original bug (a duplicate markInFlight cursor write also preserves it).
      const realUpdateTask = deps.state.updateTask.bind(deps.state);
      let execCursorWrites = 0;
      deps.state.updateTask = (rid, tid, mutator) =>
        realUpdateTask(rid, tid, (t) => {
          const next = mutator(t);
          if (
            tid === "T1" &&
            next.phase === "exec" &&
            next.status === "executing" &&
            next.spawn_in_flight === t.spawn_in_flight
          ) {
            execCursorWrites += 1;
          }
          return next;
        });

      const env = await nextAction(deps, runId, "T1", {
        result_key: env1.result_key,
        producer: { status: "STATUS: DONE" },
      });
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.phase).toBe("exec");
      // Exactly one cursor write for the resumed exec phase — not two.
      expect(execCursorWrites).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("a blocked producer escalates the rung and re-spawns the same phase", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      const env1 = await nextAction(deps, runId, "T1");
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;
      // NEEDS_CONTEXT → capability retry → rung bump (not a spec-defect fail)
      const env = await nextAction(deps, runId, "T1", {
        result_key: env1.result_key,
        producer: { status: "STATUS: NEEDS_CONTEXT" },
      });
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.phase).toBe("tests");
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.escalation_rung).toBe(1);
    } finally {
      await cleanup();
    }
  });

  // Relocated from loop.test.ts ("a producer blocked-escalate outcome fails
  // immediately as spec-defect (no retry burn)"): a BLOCKED-escalate status is a
  // spec-defect signal the producer itself raises — it fails on the FIRST spawn
  // without bumping the rung (classify-before-retry, Δ D), distinct from the
  // NEEDS_CONTEXT capability retry above.
  it("a producer blocked-escalate records to an immediate spec-defect fail (no rung burn)", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      const env1 = await nextAction(deps, runId, "T1"); // tests spawn, rung 0
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;
      const env = await nextAction(deps, runId, "T1", {
        result_key: env1.result_key,
        producer: { status: "STATUS: BLOCKED — escalate" },
      });
      expect(env).toMatchObject({
        kind: "done",
        outcome: { outcome: "failed", failure_class: "spec-defect" },
      });
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.escalation_rung).toBe(0); // never escalated
    } finally {
      await cleanup();
    }
  });

  // Relocated from loop.test.ts ("tdd_exempt task skips the test-writer"): a
  // tdd_exempt task has no tests phase — the FIRST producer spawn is the implementer.
  it("tdd_exempt task skips the tests spawn (implementer is the first producer spawn)", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", tdd_exempt: true }],
    });
    try {
      const env = await nextAction(deps, runId, "T1");
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.phase).toBe("exec");
      expect(env.request.agents[0]?.role).toBe("implementer");
    } finally {
      await cleanup();
    }
  });

  it("verify emits the 6-reviewer panel, expects reviews", async () => {
    const { deps, runId, holdout, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c", "d", "e"] }],
    });
    try {
      // Seed a holdout record so the holdout is emitted
      await holdout.put(runId, makeHoldoutRecord("T1", ["d", "e"], 5));
      await driveToVerify(deps, runId, "T1");
      const env = await nextAction(deps, runId, "T1");
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.phase).toBe("verify");
      expect(env.expects).toBe("reviews");
      expect(env.request.agents).toHaveLength(PANEL_ROLES.length);
      expect(env.holdout?.kind).toBe("holdout-validate");
      expect(env.worktree).toContain("T1");
    } finally {
      await cleanup();
    }
  });

  it("the verify spawn envelope carries the per-run base ref (origin/staging-<run-id>)", async () => {
    const { deps, runId, holdout, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c", "d", "e"] }],
    });
    try {
      await holdout.put(runId, makeHoldoutRecord("T1", ["d", "e"], 5));
      await driveToVerify(deps, runId, "T1");
      const env = await nextAction(deps, runId, "T1");
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      // The worktree forks from origin/staging-<run-id>; reviewers + the holdout
      // holdout MUST diff against THAT ref, never the namespace-colliding bare
      // `origin/staging` (root cause #2 of the PRD-2d stall).
      expect(env.base_ref).toBe(`origin/${runStagingBranch(runId)}`);
      expect(env.base_ref).toBe("origin/staging-run-1");
      expect(env.holdout?.prompt).toContain("git -C");
      expect(env.holdout?.prompt).toContain("diff origin/staging-run-1");
    } finally {
      await cleanup();
    }
  });

  it("the verify base ref + holdout prompt honor a mid-run PINNED staging branch", async () => {
    const { deps, runId, holdout, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c", "d", "e"] }],
    });
    try {
      await holdout.put(runId, makeHoldoutRecord("T1", ["d", "e"], 5));
      await driveToVerify(deps, runId, "T1");
      // Simulate a mid-run staging rename: pin a branch DIFFERING from the recompute.
      // Readers must use the pin (the branch the run actually cut), not runStagingBranch.
      await deps.state.update(runId, (s) => ({ ...s, staging_branch: "staging-PINNED" }));
      const env = await nextAction(deps, runId, "T1");
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.base_ref).toBe("origin/staging-PINNED");
      expect(env.holdout?.prompt).toContain("diff origin/staging-PINNED");
    } finally {
      await cleanup();
    }
  });

  // Relocated from src/cli/subcommands/run-task.test.ts (CLI shell deleted):
  // verify must surface the holdout holdout ONLY when an answer key was withheld.
  it("verify emits NO holdout holdout when nothing was withheld", async () => {
    // Default fixture: single criterion → degenerate split, no key persisted.
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      await driveToVerify(deps, runId, "T1");
      const env = await nextAction(deps, runId, "T1");
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.phase).toBe("verify");
      expect(env.holdout).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("recording approving reviews (+holdout pass) steps through ship to terminal done (no-merge)", async () => {
    // Use ≥2 criteria so the tests phase persists a holdout record (holdoutCount(2,20)=1).
    const { deps, runId, dataDir, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["criterion-a", "criterion-b"] }],
    });
    try {
      await driveToVerify(deps, runId, "T1");
      // Read the withheld record that the tests phase persisted.
      const holdoutRecord = await deps.holdout.get(runId, "T1");
      const withheld = holdoutRecord.withheld_criteria;
      expect(withheld.length).toBeGreaterThan(0); // sanity: split actually withheld something

      const panelEnv = await nextAction(deps, runId, "T1"); // emit panel + holdout holdout
      expect(panelEnv.kind).toBe("spawn");
      if (panelEnv.kind !== "spawn") return;
      // Record approving reviews AND holdout pass (withheld criteria → all satisfied).
      const env = await nextAction(deps, runId, "T1", approvingReviewsResults(panelEnv, withheld));
      expect(env).toMatchObject({ kind: "done", outcome: { outcome: "done" } });
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.status).toBe("done");
      expect(run.tasks["T1"]?.pr_number).toBeTypeOf("number");

      // Assert the holdout record path actually fired: verdict store has entries for T1.
      const verdictStore = new FsHoldoutVerdictStore(dataDir);
      const verdicts = await verdictStore.get(runId, "T1");
      expect(verdicts.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it("ship pushes the task branch to origin before opening the PR", async () => {
    // Regression (CP2): preflight creates the task branch locally (checkout -B)
    // and the producers commit locally — nothing pushed it to origin, so the real
    // `gh pr create --head <branch>` failed with "Head ref must be a branch / No
    // commits between". Ship MUST push the head branch to origin first.
    const { deps, runId, dataDir, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["criterion-a", "criterion-b"] }],
    });
    const git = deps.git as FakeGitClient;
    try {
      await driveToVerify(deps, runId, "T1");
      const withheld = (await deps.holdout.get(runId, "T1")).withheld_criteria;
      const panelEnv = await nextAction(deps, runId, "T1");
      expect(panelEnv.kind).toBe("spawn");
      if (panelEnv.kind !== "spawn") return;
      const env = await nextAction(deps, runId, "T1", approvingReviewsResults(panelEnv, withheld));
      expect(env).toMatchObject({ kind: "done", outcome: { outcome: "done" } });

      const branch = runScopedBranch(runId, "T1");
      // The run-scoped head branch was pushed to origin during ship.
      const pushed = git.calls.some((c) => c.startsWith("push") && c.includes(`origin ${branch}`));
      expect(pushed).toBe(true);
      // And origin now resolves that head, so a real `gh pr create --head` would succeed.
      expect(await git.lsRemoteHeads("origin", branch)).not.toBeNull();
      void dataDir;
    } finally {
      await cleanup();
    }
  });

  it("a blocked merge gate escalates and resumes at exec", async () => {
    const { deps, runId, dataDir, cleanup } = await makeOrchestratorDeps();
    try {
      await driveToVerify(deps, runId, "T1");
      // Write the cited file into the worktree so citation-verify can confirm it.
      const worktree = taskWorktreePath(dataDir, runId, "T1");
      const citedFile = join(worktree, "src", "x.ts");
      await mkdir(dirname(citedFile), { recursive: true });
      await writeFile(citedFile, "bad code\n");
      const panelEnv = await nextAction(deps, runId, "T1");
      expect(panelEnv.kind).toBe("spawn");
      if (panelEnv.kind !== "spawn") return;
      const env = await nextAction(deps, runId, "T1", blockingReviewsResults(panelEnv));
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.phase).toBe("exec");
    } finally {
      await cleanup();
    }
  });

  it("an exhausted ladder is a classified capability-budget failure", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      taskStateOverrides: { task_id: "T1", escalation_rung: ESCALATION_CAP },
    });
    try {
      const env1 = await nextAction(deps, runId, "T1");
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;
      // NEEDS_CONTEXT → capability retry → rung already at cap → fails capability-budget
      const env = await nextAction(deps, runId, "T1", {
        result_key: env1.result_key,
        producer: { status: "STATUS: NEEDS_CONTEXT" },
      });
      expect(env).toMatchObject({
        kind: "done",
        outcome: { outcome: "failed", failure_class: "capability-budget" },
      });
    } finally {
      await cleanup();
    }
  });

  it("live-merge BEHIND exhausted cap fails blocked-environmental", async () => {
    // Pre-seed an OPEN-but-BEHIND PR so every merge attempt refuses.
    // baseRefName must use the per-run staging branch so createTaskPrIdempotent
    // finds this PR (it now filters by base: runStagingBranch(runId) = "staging-run-1").
    const gh = new FakeGhClient();
    const branch = "factory/run-1/T1";
    gh.setPr({
      number: 500,
      headRefName: branch,
      baseRefName: "staging-run-1",
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
      url: "https://github.com/fake/repo/pull/500",
    });
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c"] }],
      shipMode: "live",
      ghClient: gh,
      taskStateOverrides: {
        task_id: "T1",
        phase: "ship" as const,
        status: "shipping",
        merge_resyncs: MERGE_RESYNC_CAP,
        branch,
        pr_number: 500,
      },
    });
    try {
      const env = await nextAction(deps, runId, "T1");
      expect(env).toMatchObject({
        kind: "done",
        outcome: { outcome: "failed", failure_class: "blocked-environmental" },
      });
    } finally {
      await cleanup();
    }
  });

  // Relocated from loop.test.ts ("a BEHIND merge re-routes through exec to re-sync,
  // then lands on the next attempt"): the live serial-writer refusal is NOT a
  // capability failure — it re-routes to an exec re-sync (bumping merge_resyncs),
  // and once the branch is up to date the merge lands. In the orchestrator model the
  // re-sync surfaces as a fresh exec spawn the caller records DONE.
  it("live-merge BEHIND-once re-routes to an exec re-sync, then lands on the next attempt", async () => {
    // A gh client that reports BEHIND on the FIRST prView, CLEAN thereafter.
    class BehindOnceGh extends FakeGhClient {
      private views = 0;
      override async prView(n: number, fields: readonly string[]) {
        const pr = await super.prView(n, fields);
        this.views += 1;
        return this.views === 1 ? { ...pr, mergeStateStatus: "BEHIND" as const } : pr;
      }
    }
    const gh = new BehindOnceGh();
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c"] }],
      shipMode: "live",
      ghClient: gh,
    });
    try {
      const panelEnv = await driveToVerify(deps, runId, "T1");
      const withheld = (await deps.holdout.get(runId, "T1")).withheld_criteria;
      // Record approving reviews (+holdout pass) → the orchestrator runs ship; the first
      // prView is BEHIND, so it re-routes to an exec re-sync (a fresh exec spawn),
      // bumping merge_resyncs.
      const resyncEnv = await nextAction(
        deps,
        runId,
        "T1",
        approvingReviewsResults(panelEnv, withheld),
      );
      expect(resyncEnv.kind).toBe("spawn");
      if (resyncEnv.kind !== "spawn") throw new Error("expected an exec re-sync spawn");
      expect(resyncEnv.phase).toBe("exec");
      const midRun = await deps.state.read(runId);
      expect(midRun.tasks["T1"]?.merge_resyncs).toBe(1);

      // Record DONE for the re-sync exec → ship runs again; prView is now CLEAN → merge lands.
      const env = await nextAction(deps, runId, "T1", {
        result_key: resyncEnv.result_key,
        producer: { status: "STATUS: DONE" },
      });
      expect(env).toMatchObject({ kind: "done", outcome: { outcome: "done" } });
      expect(gh.created).toHaveLength(1); // PR created once (idempotent on re-ship)
      expect(gh.merges).toHaveLength(1); // merged once (the 2nd attempt)
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.status).toBe("done");
    } finally {
      await cleanup();
    }
  });

  // Crash-safety pin (final-review finding 1): the ship→exec re-sync must bump
  // merge_resyncs AND move the resume cursor to exec in ONE atomic write. The old
  // two-write sequence (bump, then a separate markInFlight at the loop top) left a
  // crash window where merge_resyncs was committed while the cursor stayed "ship" —
  // a no-results resume would re-run ship, re-refuse, and DOUBLE-SPEND the budget.
  it("ship re-sync bumps merge_resyncs and moves the cursor to exec in ONE atomic write (no crash double-spend)", async () => {
    // gh ALWAYS reports BEHIND → ship always refuses → the re-sync path runs.
    class AlwaysBehindGh extends FakeGhClient {
      override async prView(n: number, fields: readonly string[]) {
        const pr = await super.prView(n, fields);
        return { ...pr, mergeStateStatus: "BEHIND" as const };
      }
    }
    const gh = new AlwaysBehindGh();
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c"] }],
      shipMode: "live",
      ghClient: gh,
    });
    try {
      const panelEnv = await driveToVerify(deps, runId, "T1");
      const withheld = (await deps.holdout.get(runId, "T1")).withheld_criteria;

      // Record every committed (merge_resyncs, phase) snapshot for T1.
      const realUpdateTask = deps.state.updateTask.bind(deps.state);
      const snapshots: Array<{ merge_resyncs: number; phase: string | undefined }> = [];
      deps.state.updateTask = (rid, tid, mutator) =>
        realUpdateTask(rid, tid, (t) => {
          const next = mutator(t);
          if (tid === "T1") {
            snapshots.push({ merge_resyncs: next.merge_resyncs, phase: next.phase });
          }
          return next;
        });

      // Record approving reviews (+holdout pass) → ship runs, refuses (BEHIND) → re-sync.
      const env = await nextAction(deps, runId, "T1", approvingReviewsResults(panelEnv, withheld));
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") throw new Error("expected an exec re-sync spawn");
      expect(env.phase).toBe("exec");

      // The write that first sets merge_resyncs=1 must ALSO carry phase="exec" — no
      // committed snapshot may pair merge_resyncs=1 with the stale "ship" cursor.
      const bumpWrite = snapshots.find((s) => s.merge_resyncs === 1);
      expect(bumpWrite).toBeDefined();
      expect(bumpWrite?.phase).toBe("exec");
      expect(snapshots.some((s) => s.merge_resyncs === 1 && s.phase === "ship")).toBe(false);

      // Persisted resume cursor is exec (not ship) → a crash-resume re-runs exec,
      // never re-refuses ship to re-bump the budget.
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.phase).toBe("exec");
      expect(run.tasks["T1"]?.merge_resyncs).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("results at a non-spawn phase (preflight) fail loud", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      // T1 is pending → phase is implicitly preflight (no cursor yet)
      await expect(
        nextAction(deps, runId, "T1", {
          result_key: { phase: "tests", rung: 0 },
          producer: { status: "STATUS: DONE" },
        }),
      ).rejects.toThrow(/spawns no agents|preflight/i);
    } finally {
      await cleanup();
    }
  });

  it("producer results at verify fail loud (expects mismatch)", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      await driveToVerify(deps, runId, "T1");
      const panelEnv = await nextAction(deps, runId, "T1"); // emit panel → phase cursor = "verify"
      expect(panelEnv.kind).toBe("spawn");
      if (panelEnv.kind !== "spawn") return;
      await expect(
        nextAction(deps, runId, "T1", {
          result_key: panelEnv.result_key,
          producer: { status: "STATUS: DONE" },
        }),
      ).rejects.toThrow(/expects reviews/i);
    } finally {
      await cleanup();
    }
  });

  it("a quota breach short-circuits to quota-blocked before any phase work", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({ usage: PAUSE_5H });
    try {
      const env = await nextAction(deps, runId, "T1");
      expect(env).toMatchObject({ kind: "pause", scope: "5h" });
      // No phase cursor was written — the orchestrator bailed before any phase work.
      const run = await deps.state.read(runId);
      expect(run.tasks["T1"]?.phase).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("a terminal task returns its terminal envelope idempotently", async () => {
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps();
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
      const env = await nextAction(deps, runId, "T1");
      expect(env).toMatchObject({ kind: "done", outcome: { outcome: "done" } });
    } finally {
      await cleanup();
    }
  });

  it("stale results (result_key tests/0) reject LOUD after DONE advances tests→exec", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      const env1 = await nextAction(deps, runId, "T1"); // tests spawn, result_key tests/0
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") throw new Error("expected spawn");
      const testsResults: DriveResults = {
        result_key: env1.result_key, // { phase: "tests", rung: 0 }
        producer: { status: "STATUS: DONE" },
      };
      // Record DONE: advances cursor to exec.
      const env2 = await nextAction(deps, runId, "T1", testsResults);
      expect(env2.kind).toBe("spawn");
      if (env2.kind !== "spawn") throw new Error("expected exec spawn");
      expect(env2.phase).toBe("exec");

      // Re-deliver the SAME results (result_key tests/0) after cursor moved to exec/0.
      await expect(nextAction(deps, runId, "T1", testsResults)).rejects.toThrow(/stale or duplicate/);
    } finally {
      await cleanup();
    }
  });

  it("duplicate NEEDS_CONTEXT results (result_key tests/0) reject LOUD and do not double-bump escalation_rung", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      const env1 = await nextAction(deps, runId, "T1"); // tests spawn, result_key tests/0
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") throw new Error("expected spawn");
      const needsContextResults: DriveResults = {
        result_key: env1.result_key, // { phase: "tests", rung: 0 }
        producer: { status: "STATUS: NEEDS_CONTEXT" },
      };
      // First record: bumps escalation_rung to 1.
      const env2 = await nextAction(deps, runId, "T1", needsContextResults);
      expect(env2.kind).toBe("spawn");
      if (env2.kind !== "spawn") throw new Error("expected spawn after escalation");
      expect(env2.phase).toBe("tests");
      const runAfter = await deps.state.read(runId);
      expect(runAfter.tasks["T1"]?.escalation_rung).toBe(1);

      // Re-deliver the SAME results (result_key tests/0) — rung is now 1, mismatch.
      await expect(nextAction(deps, runId, "T1", needsContextResults)).rejects.toThrow(
        /stale or duplicate/,
      );
      // Rung must still be 1 — no double-bump.
      const runFinal = await deps.state.read(runId);
      expect(runFinal.tasks["T1"]?.escalation_rung).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it("spawn envelope carries result_key that matches cursor phase and rung", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps({
      taskStateOverrides: { task_id: "T1", escalation_rung: 2 },
    });
    try {
      const env = await nextAction(deps, runId, "T1");
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") return;
      expect(env.result_key).toEqual({ phase: env.phase, rung: 2 });
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
    const { deps, runId, state, cleanup } = await makeOrchestratorDeps({ usage: PAUSE_5H });
    try {
      // Seed the task as done (terminal).
      await state.update(runId, (s) => ({
        ...s,
        tasks: { T1: { ...s.tasks["T1"]!, status: "done" } },
      }));
      const env = await nextAction(deps, runId, "T1");
      // Must be terminal, NOT quota-blocked.
      expect(env).toMatchObject({ kind: "done", outcome: { outcome: "done" } });
      // No quota checkpoint was written (applyQuotaGate never ran).
      // The gate writes run.status (→ "paused") and run.quota; both must be untouched.
      const run = await deps.state.read(runId);
      expect(run.status).toBe("running"); // gate would have changed this to "paused"
      expect(run.quota).toBeUndefined(); // gate would have written the 5h checkpoint
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
    // Simulate a rogue hook write: task arrives at the orchestrator with reviewers[] already populated
    // and phase=verify, but no holdout verdict has been recorded yet.
    // Expected: the verify handler detects missing holdout evidence and re-spawns the panel
    // (fail-closed), NOT derives from the persisted reviewers and advances to ship.
    const { deps, runId, holdout, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c"] }],
      taskStateOverrides: {
        task_id: "T1",
        phase: "verify" as const,
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
      // No verdict store entry — simulates the crash-between-hook-write-and-record scenario.

      const env = await nextAction(deps, runId, "T1");
      // Must re-spawn the verify panel, NOT advance to ship.
      expect(env.kind).toBe("spawn");
      if (env.kind !== "spawn") throw new Error("expected spawn envelope for fail-closed re-spawn");
      expect(env.phase).toBe("verify");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 3: recordResults requires holdout results when answer key is withheld
// ---------------------------------------------------------------------------

describe("recordResults holdout-required guard", () => {
  it("holdout-bearing task at verify with reviews but no holdout → rejects with /withheld holdout answer key/", async () => {
    // 5 criteria at holdoutPercent=20% → holdoutCount(5,20)=1 — guarantees a withheld key.
    const { deps, runId, dataDir, cleanup } = await makeOrchestratorDeps({
      tasks: [{ task_id: "T1", acceptance_criteria: ["a", "b", "c", "d", "e"] }],
    });
    try {
      await driveToVerify(deps, runId, "T1");
      const panelEnv = await nextAction(deps, runId, "T1");
      expect(panelEnv.kind).toBe("spawn");
      if (panelEnv.kind !== "spawn") throw new Error("expected panel spawn");
      expect(panelEnv.holdout?.kind).toBe("holdout-validate"); // sanity: holdout was withheld

      // Seed prior-rung verdicts on disk: without the guard, applyRecordReviews would read
      // these successfully (no ENOENT) and NOT throw — so the test only fails without the guard.
      const verdictStore = new FsHoldoutVerdictStore(dataDir);
      await verdictStore.put(runId, "T1", [
        { criterion: "e", satisfied: true, evidence: "prior rung evidence" },
      ]);

      // Deliver reviews WITHOUT the holdout field (no withheld arg → no holdout in results).
      const resultsWithoutHoldout = approvingReviewsResults(panelEnv);
      // Guard must throw its specific message, not an ENOENT path that happens to mention "holdout".
      await expect(nextAction(deps, runId, "T1", resultsWithoutHoldout)).rejects.toThrow(
        /withheld holdout answer key/,
      );
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// result_key schema rejection (schema-level, not orchestrator-level)
// ---------------------------------------------------------------------------

describe("result_key validation (Important 1 — schema gate)", () => {
  it("result_key mismatch on phase rejects with /stale or duplicate/", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      const env1 = await nextAction(deps, runId, "T1");
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;
      // Lie: claim result_key.phase is "exec" but cursor is "tests"
      const wrongKey: ResultKey = { phase: "exec", rung: 0 };
      await expect(
        nextAction(deps, runId, "T1", { result_key: wrongKey, producer: { status: "STATUS: DONE" } }),
      ).rejects.toThrow(/stale or duplicate/);
    } finally {
      await cleanup();
    }
  });

  it("result_key mismatch on rung rejects with /stale or duplicate/", async () => {
    const { deps, runId, cleanup } = await makeOrchestratorDeps();
    try {
      const env1 = await nextAction(deps, runId, "T1");
      expect(env1.kind).toBe("spawn");
      if (env1.kind !== "spawn") return;
      // Lie: claim rung 99 but actual is 0
      const wrongKey: ResultKey = { phase: "tests", rung: 99 };
      await expect(
        nextAction(deps, runId, "T1", { result_key: wrongKey, producer: { status: "STATUS: DONE" } }),
      ).rejects.toThrow(/stale or duplicate/);
    } finally {
      await cleanup();
    }
  });
});
