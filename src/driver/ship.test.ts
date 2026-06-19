/**
 * WS10 — unit tests for shipTask.
 *
 * shipTask is the fully-deterministic ship stage: it pushes the task branch,
 * opens (or looks up) the PR idempotently, records branch + pr_number into
 * state, and (in `live` mode) serial-merges via MergeSerializer. All I/O is
 * injectable (FakeGitClient + FakeGhClient + real StateManager in a tmpdir).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shipTask, type ShipDeps } from "./ship.js";

import { defaultConfig } from "../config/schema.js";
import { parseSpecManifest } from "../spec/schema.js";
import type { SpecManifest } from "../spec/index.js";
import { StateManager } from "../core/state/manager.js";
import { FakeGitClient, FakeGhClient } from "../git/fakes.js";
import { makeFakeTools } from "../verifier/deterministic/fakes.js";
import { InMemoryHoldoutStore } from "../verifier/holdout/index.js";
import { InMemoryArtifactStore } from "./artifacts.js";
import type { StageContext, TaskState } from "../types/index.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeSpec(): SpecManifest {
  return parseSpecManifest({
    spec_id: "42-checkout",
    issue_number: 42,
    slug: "checkout",
    repo: "acme/widgets",
    generated_at: "2026-06-01T00:00:00.000Z",
    tasks: [
      {
        task_id: "t-1",
        title: "implement checkout",
        description: "add checkout flow",
        files: ["src/checkout.ts"],
        acceptance_criteria: ["a", "b"],
        tests_to_write: ["covers a and b"],
        depends_on: [],
        risk_tier: "medium",
        risk_rationale: "moderate blast radius",
      },
    ],
  });
}

interface ShipFixture {
  deps: ShipDeps;
  state: StateManager;
  gh: FakeGhClient;
  git: FakeGitClient;
  dataDir: string;
  ctx: StageContext;
}

async function makeShipFixture(opts: {
  runId: string;
  shipMode?: "live" | "no-merge";
}): Promise<ShipFixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "factory-ship-"));
  const state = new StateManager({
    dataDir,
    lock: { stale: 5000, retries: 200, retryMinTimeout: 5, retryMaxTimeout: 50 },
  });
  const git = new FakeGitClient({
    remoteHeads: { staging: "sha-staging" },
    localBranches: { [`factory/${opts.runId}/t-1`]: { sha: "sha-task" } },
  });
  const gh = new FakeGhClient();

  await state.create({
    run_id: opts.runId,
    spec: { repo: "acme/widgets", spec_id: "42-checkout", issue_number: 42 },
  });
  await state.update(opts.runId, (s) => ({
    ...s,
    tasks: {
      ...s.tasks,
      "t-1": {
        task_id: "t-1",
        status: "shipping" as const,
        depends_on: [],
        risk_tier: "medium" as const,
        escalation_rung: 0,
        reviewers: [],
        merge_resyncs: 0,
      },
    },
  }));

  const run = await state.read(opts.runId);
  const task = run.tasks["t-1"] as TaskState;
  const ctx: StageContext = { run, task, attempt: 1 };

  const deps: ShipDeps = {
    config: defaultConfig(),
    spec: makeSpec(),
    git,
    gh,
    tools: makeFakeTools(),
    artifacts: new InMemoryArtifactStore(),
    holdout: new InMemoryHoldoutStore(),
    dataDir,
    owner: "acme",
    repo: "widgets",
    shipMode: opts.shipMode ?? "no-merge",
    state,
  };

  return { deps, state, gh, git, dataDir, ctx };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("shipTask", () => {
  const fixtures: string[] = [];

  afterEach(async () => {
    for (const d of fixtures.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it("ships task PRs against staging/<run-id> (no-merge mode)", async () => {
    const { deps, ctx, gh, dataDir } = await makeShipFixture({ runId: "run-A" });
    fixtures.push(dataDir);

    const result = await shipTask(deps, ctx);

    expect(result).toEqual({ kind: "task-terminal", outcome: { outcome: "done" } });
    // PR was created with the per-run staging branch as base
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0]?.base).toBe("staging-run-A");
  });

  it("ships task PRs against staging/<run-id> in live mode and serializer targets per-run branch", async () => {
    const { deps, ctx, gh, dataDir } = await makeShipFixture({ runId: "run-B", shipMode: "live" });
    fixtures.push(dataDir);

    const result = await shipTask(deps, ctx);

    expect(result).toEqual({ kind: "task-terminal", outcome: { outcome: "done" } });
    // PR base is the per-run staging branch
    expect(gh.created[0]?.base).toBe("staging-run-B");
    // Serializer executed a merge (confirms it reached the merge path with per-run branch)
    expect(gh.merges).toHaveLength(1);
    // The merged PR had base pointing at the per-run staging branch
    const mergedPr = gh.prs.get("factory/run-B/t-1");
    expect(mergedPr?.baseRefName).toBe("staging-run-B");
  });

  it("records branch and pr_number in state after ship", async () => {
    const { deps, ctx, state, dataDir } = await makeShipFixture({ runId: "run-C" });
    fixtures.push(dataDir);

    await shipTask(deps, ctx);

    const run = await state.read("run-C");
    const task = run.tasks["t-1"]!;
    expect(task.branch).toBe("factory/run-C/t-1");
    expect(task.pr_number).toBeGreaterThan(0);
  });
});
